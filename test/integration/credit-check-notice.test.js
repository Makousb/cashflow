// Telling somebody a lender has asked. Real database, stubbed transport — the
// environment is read when the mailer first loads, hence the assignments before
// the dynamic imports.
process.env.SMTP_HOST = "smtp.invalid";
process.env.SMTP_PORT = "587";
process.env.MAIL_FROM = "Cashflow <no-reply@test.invalid>";

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

const { __setTransport } = await import("../../services/mailer.js");
const { catchUpRequestNotices } = await import("../../controllers/credit-check.controller.js");
const { createRequest, ensureCreditCode, unnotifiedRequests } =
  await import("../../db/queries/credit-checks.js");
const { closePool, dropUser, makeUser, one, q, skipWithoutDb } =
  await import("./helpers.js");

const sent = [];
function transportThat(behaviour) {
  __setTransport({
    sendMail: async (message) => {
      if (behaviour) return behaviour(message);
      sent.push(message);
      return { messageId: "stub" };
    }
  });
}

describe("an ask arriving", { skip: skipWithoutDb }, () => {
  let user;

  before(async () => {
    user = await makeUser("request-notice");
    await q("UPDATE users SET name = 'Asha Mwangi' WHERE id = $1", [user.id]);
    await ensureCreditCode(user.id);
  });

  beforeEach(() => {
    sent.length = 0;
    transportThat();
  });

  after(async () => { await dropUser(user?.id); });

  test("is emailed to the person it is about", async () => {
    await createRequest({
      userId: user.id, lender: "Equity Bank", purpose: "mortgage",
      amountSought: 4500000, reference: "MTG-771"
    });
    await catchUpRequestNotices({ id: user.id });

    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /Equity Bank is asking/);
    assert.match(sent[0].text, /Their reference: MTG-771/);
    assert.match(sent[0].text, /shown nothing/);
  });

  test("and never twice for the same ask", async () => {
    await catchUpRequestNotices({ id: user.id });
    assert.equal(sent.length, 0, "one ask, one email");
    assert.equal((await unnotifiedRequests(user.id)).length, 0);
  });

  test("a second lender is its own email", async () => {
    await createRequest({ userId: user.id, lender: "Absa", purpose: "car_loan" });
    await catchUpRequestNotices({ id: user.id });

    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /Absa is asking/);
  });

  test("an answered ask is not chased", async () => {
    // Only pending ones are worth an email; approving or denying settles it.
    await createRequest({ userId: user.id, lender: "Stanbic", purpose: "business_loan" });
    await q(
      "UPDATE credit_check_requests SET status = 'denied' WHERE lender = 'Stanbic' AND user_id = $1",
      [user.id]
    );
    await catchUpRequestNotices({ id: user.id });
    assert.equal(sent.length, 0);
  });
});

describe("when the mail does not go", { skip: skipWithoutDb }, () => {
  let user;

  before(async () => {
    user = await makeUser("request-notice-retry");
    await createRequest({ userId: user.id, lender: "Co-op Bank", purpose: "mortgage" });
  });

  after(async () => { await dropUser(user?.id); });

  test("the ask is left to be told about again", async () => {
    sent.length = 0;
    transportThat(() => { throw new Error("mail server having a bad afternoon"); });
    await catchUpRequestNotices({ id: user.id });

    assert.equal(sent.length, 0);
    assert.equal(
      (await unnotifiedRequests(user.id)).length, 1,
      "an email that did not go must not count as told"
    );
  });

  test("so opening the app again sends it", async () => {
    sent.length = 0;
    transportThat();
    await catchUpRequestNotices({ id: user.id });

    assert.equal(sent.length, 1);
    assert.equal((await unnotifiedRequests(user.id)).length, 0);
  });

  test("and with nowhere to send it, it is still owed", async () => {
    await q("UPDATE users SET email = '' WHERE id = $1", [user.id]);
    await createRequest({ userId: user.id, lender: "Nowhere Bank", purpose: "other" });

    sent.length = 0;
    transportThat();
    await catchUpRequestNotices({ id: user.id });

    assert.equal(sent.length, 0);
    const owed = await unnotifiedRequests(user.id);
    assert.equal(owed.length, 1, "nothing was sent, so nothing was told");
    assert.equal(owed[0].lender, "Nowhere Bank");
  });
});

describe("an ask arriving over HTTP", { skip: skipWithoutDb }, () => {
  // The submit path tells the person straight away rather than waiting for the
  // sweep, and it does so without the lender being able to tell either way.
  let user;
  let server;
  let base;
  let code;

  before(async () => {
    process.env.CASHFLOW_NO_LISTEN = "1";
    const { default: app } = await import("../../app.js");
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    user = await makeUser("request-http");
    await q("UPDATE users SET name = 'Asha Mwangi' WHERE id = $1", [user.id]);
    code = await ensureCreditCode(user.id);
  });

  after(async () => {
    await dropUser(user?.id);
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test("is sent without the lender waiting on it, or learning of it", async () => {
    sent.length = 0;
    transportThat();

    const res = await fetch(`${base}/credit-check/request`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, lender: "Equity Bank", purpose: "mortgage"
      }).toString(),
      redirect: "manual"
    });
    const body = await res.text();

    assert.equal(res.status, 200);
    // Nothing in what the lender is handed says whether an email went, or to
    // whom — that would be another way of learning the code was real.
    assert.doesNotMatch(body, /Asha Mwangi/);
    assert.doesNotMatch(body, /email/i);

    // The send is not awaited by the response, so give it a moment.
    for (let i = 0; i < 40 && sent.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(sent.length, 1, "the person should have been told");
    assert.match(sent[0].subject, /Equity Bank is asking/);
  });

  test("and a code nobody holds sends nothing, silently", async () => {
    sent.length = 0;
    transportThat();

    const res = await fetch(`${base}/credit-check/request`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: "CR-ZZZZZZZZ", lender: "Equity Bank", purpose: "mortgage"
      }).toString(),
      redirect: "manual"
    });

    assert.equal(res.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(sent.length, 0);
  });
});

describe("the code a lender asks against", { skip: skipWithoutDb }, () => {
  let user;

  before(async () => { user = await makeUser("credit-code"); });
  after(async () => { await dropUser(user?.id); });

  test("is made once and kept", async () => {
    const first = await ensureCreditCode(user.id);
    const again = await ensureCreditCode(user.id);
    assert.equal(first, again);
    assert.match(first, /^CR-[0-9A-Z]{8}$/);
  });

  test("leaves out the characters people misread aloud", async () => {
    const code = await ensureCreditCode(user.id);
    assert.doesNotMatch(code.slice(3), /[01ILOU]/);
  });

  test("is not worked out from the row, so nobody can compute anybody's", async () => {
    const other = await makeUser("credit-code-other");
    const theirs = await ensureCreditCode(other.id);
    assert.notEqual(theirs, await ensureCreditCode(user.id));
    await dropUser(other.id);
  });

  test("is stored where a lender's code can be looked up against it", async () => {
    const code = await ensureCreditCode(user.id);
    const row = await one("SELECT credit_code FROM users WHERE id = $1", [user.id]);
    assert.equal(row.credit_code, code);
  });
});

// One teardown for the whole file — every suite in it shares the same pool.
after(async () => {
  await closePool();
});
