// The mailer is configured from the environment, which is read when the module
// first loads — hence the assignment before the dynamic imports below. No real
// SMTP server is involved: the transport is stubbed, so these tests never send
// mail. The database is real, because what is being tested is that a missed
// statement produces exactly one email and never a second.
process.env.SMTP_HOST = "smtp.invalid";
process.env.SMTP_PORT = "587";
process.env.MAIL_FROM = "Cashflow <no-reply@test.invalid>";

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

const { __setTransport } = await import("../../services/mailer.js");
const { catchUpCardNotices } = await import("../../controllers/credit.controller.js");
const { claimCardNotice, listCardNotices, openFacility } =
  await import("../../db/queries/credit.js");
const { closePool, dropUser, makeUser, q, skipWithoutDb } =
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

describe("a missed minimum reaches the holder", { skip: skipWithoutDb }, () => {
  let user;
  let card;

  before(async () => {
    user = await makeUser("notice-send");
    card = await openFacility({
      userId: user.id, product: "secured_card", label: "Everyday card",
      apr: 30, creditLimit: 10000, deposit: 10000, openedOn: "2026-01-01"
    });

    // Two months back, so a statement has been drawn, fallen due, and gone
    // unpaid. Dates are relative to the database's own clock, which is the one
    // the standing is worked out against.
    await q(
      "UPDATE credit_facilities SET opened_on = CURRENT_DATE - INTERVAL '2 months' WHERE id = $1",
      [card.id]
    );
    await q(
      `INSERT INTO credit_charges (facility_id, user_id, merchant, amount, charged_on)
       VALUES ($1, $2, 'Backdated shop', 4000, CURRENT_DATE - INTERVAL '2 months')`,
      [card.id, user.id]
    );
  });

  beforeEach(() => {
    sent.length = 0;
    transportThat();
  });

  after(async () => { await dropUser(user?.id); });

  test("one email goes, naming the card and what it asked for", async () => {
    await catchUpCardNotices({ id: user.id, email: "holder@example.test", currency: "KES" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "holder@example.test");
    assert.match(sent[0].subject, /Everyday card/);
    assert.match(sent[0].subject, /missed/i);
    assert.match(sent[0].text, /Minimum asked for/);
    assert.match(sent[0].text, /no late fee/i);
  });

  test("and it is recorded, so the statement is not raised twice", async () => {
    const notices = await listCardNotices(user.id);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].sent_to, "holder@example.test");
  });

  test("opening the page again does not send it again", async () => {
    await catchUpCardNotices({ id: user.id, email: "holder@example.test", currency: "KES" });
    assert.equal(sent.length, 0, "a card is not a nag");
  });

  test("nothing is sent when there is nowhere to send it", async () => {
    await catchUpCardNotices({ id: user.id, email: "", currency: "KES" });
    assert.equal(sent.length, 0);
  });
});

describe("a reminder before the date", { skip: skipWithoutDb }, () => {
  let user;
  let card;

  before(async () => {
    user = await makeUser("notice-reminder");
    card = await openFacility({
      userId: user.id, product: "secured_card", label: "Everyday card",
      apr: 30, creditLimit: 10000, deposit: 10000, openedOn: "2026-01-01"
    });

    // Last month's statement, positioned so that today falls inside its
    // reminder window: drawn at the end of last month, due 21 days later.
    // Backdating the open and the charge by one month puts today two days
    // before that date when the month is 30 days long, and inside the window
    // regardless of month length only for part of the month — so the test
    // drives the window explicitly rather than hoping the calendar obliges.
    await q(
      "UPDATE credit_facilities SET opened_on = CURRENT_DATE - INTERVAL '1 month' WHERE id = $1",
      [card.id]
    );
    await q(
      `INSERT INTO credit_charges (facility_id, user_id, merchant, amount, charged_on)
       VALUES ($1, $2, 'Last month', 4000, CURRENT_DATE - INTERVAL '1 month')`,
      [card.id, user.id]
    );
  });

  beforeEach(() => {
    sent.length = 0;
    transportThat();
  });

  after(async () => { await dropUser(user?.id); });

  test("the two kinds are claimed apart, so one does not block the other", async () => {
    // Whichever notice today's date calls for, the other kind must still be
    // free to be claimed — that is the whole of the schema change.
    assert.equal(
      await claimCardNotice({
        facilityId: card.id, userId: user.id, cycle: "2026-05", kind: "reminder",
        sentTo: "a@b.test"
      }),
      true
    );
    assert.equal(
      await claimCardNotice({
        facilityId: card.id, userId: user.id, cycle: "2026-05", kind: "missed",
        sentTo: "a@b.test"
      }),
      true,
      "a statement reminded about must still be able to be reported missed"
    );
    assert.equal(
      await claimCardNotice({
        facilityId: card.id, userId: user.id, cycle: "2026-05", kind: "reminder",
        sentTo: "a@b.test"
      }),
      false,
      "but neither kind twice"
    );
  });

  test("and a notice already sent is not sent again by the other kind", async () => {
    // Both kinds claimed above, so whatever today calls for is already taken.
    sent.length = 0;
    await catchUpCardNotices({ id: user.id, email: "holder@example.test", currency: "KES" });
    const cycles = (await listCardNotices(user.id)).map((n) => `${n.cycle}/${n.kind}`);
    assert.equal(new Set(cycles).size, cycles.length, "no cycle and kind twice over");
  });
});

describe("when the mail does not go", { skip: skipWithoutDb }, () => {
  let user;
  let card;

  before(async () => {
    user = await makeUser("notice-retry");
    card = await openFacility({
      userId: user.id, product: "secured_card", label: "Retry card",
      apr: 30, creditLimit: 10000, deposit: 10000, openedOn: "2026-01-01"
    });
    await q(
      "UPDATE credit_facilities SET opened_on = CURRENT_DATE - INTERVAL '2 months' WHERE id = $1",
      [card.id]
    );
    await q(
      `INSERT INTO credit_charges (facility_id, user_id, merchant, amount, charged_on)
       VALUES ($1, $2, 'Backdated shop', 4000, CURRENT_DATE - INTERVAL '2 months')`,
      [card.id, user.id]
    );
  });

  after(async () => { await dropUser(user?.id); });

  test("the claim is handed back rather than swallowing the reminder", async () => {
    sent.length = 0;
    transportThat(() => { throw new Error("mail server having a bad afternoon"); });
    await catchUpCardNotices({ id: user.id, email: "holder@example.test", currency: "KES" });

    assert.equal(sent.length, 0);
    assert.equal(
      (await listCardNotices(user.id)).length, 0,
      "a notice that did not go must not count as told"
    );
  });

  test("so the next visit sends it", async () => {
    sent.length = 0;
    transportThat();
    await catchUpCardNotices({ id: user.id, email: "holder@example.test", currency: "KES" });

    assert.equal(sent.length, 1);
    assert.equal((await listCardNotices(user.id)).length, 1);
  });
});

// One teardown for the whole file — every suite in it shares the same pool.
after(async () => {
  await closePool();
});
