// config/env.js reads these once at import, so they must be set before app.js
// (or anything importing it) is ever imported — same reason
// accountant-guard.test.js sets its provider env vars up front.
process.env.CASHFLOW_NO_LISTEN = "1";
process.env.MONO_SECRET_KEY = "test-sec-key-not-real";
process.env.MONO_WEBHOOK_SECRET = "test-webhook-secret";

import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";

// Both dynamic, and after the env vars above: a static import is hoisted
// ahead of this file's own top-level code, so helpers.js (which reaches
// db/index.js, which reads config/env.js) would build config.mono from
// process.env before MONO_WEBHOOK_SECRET was ever set — exactly the trap
// accountant-guard.test.js's own comment describes, just one import deeper.
const { closePool, dropUser, makeUser, one, q, skipWithoutDb } =
  await import("./helpers.js");
const { makeLinkRef } = await import("../../services/mono.js");

let server;
let base;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Stands in for Mono's own API, which the webhook handler calls back into
// (getAccountDetails after account_connected, listTransactions after
// account_updated) — these must never reach the real network in a test.
function monoSays(byPath) {
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const match = Object.keys(byPath).find((p) => path.includes(p));
    return { ok: true, json: async () => byPath[match] || {} };
  };
}

async function postWebhook(payload, headers = {}) {
  // Always the real network fetch, never whatever monoSays() has the global
  // stubbed to for the app's own outbound calls — this is the test's request
  // TO the app, over a real socket to the ephemeral server below.
  const res = await realFetch(base + "/accounts/mono/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload)
  });
  return { status: res.status };
}

describe("Mono webhook", { skip: skipWithoutDb }, () => {
  let user;

  before(async () => {
    const { default: app } = await import("../../app.js");
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    user = await makeUser("mono");
  });

  after(async () => {
    await dropUser(user?.id);
    await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  test("without the right secret header, nothing happens", async () => {
    const ref = makeLinkRef(user.id);
    const missing = await postWebhook({
      event: "mono.events.account_connected",
      data: { id: "mono-acc-nosecret", meta: { ref } }
    });
    assert.equal(missing.status, 401);

    const wrong = await postWebhook(
      { event: "mono.events.account_connected", data: { id: "mono-acc-nosecret", meta: { ref } } },
      { "mono-webhook-secret": "not-the-right-one" }
    );
    assert.equal(wrong.status, 401);

    const rows = await q("SELECT id FROM accounts WHERE mono_account_id = $1", ["mono-acc-nosecret"]);
    assert.equal(rows.length, 0, "an unauthenticated call must not link anything");
  });

  test("account_connected links a wallet to the user named in its own ref, and a replay does not duplicate it", async () => {
    monoSays({
      "/v2/accounts/mono-acc-1": {
        data: { account: { institution: { name: "Test Sandbox Bank" }, accountNumber: "0123456789" } }
      }
    });

    const ref = makeLinkRef(user.id);
    const payload = {
      event: "mono.events.account_connected",
      data: { id: "mono-acc-1", meta: { ref } }
    };

    const first = await postWebhook(payload, { "mono-webhook-secret": "test-webhook-secret" });
    assert.equal(first.status, 200);

    const linked = await one(
      "SELECT * FROM accounts WHERE mono_account_id = $1", ["mono-acc-1"]
    );
    assert.equal(linked.user_id, user.id);
    assert.equal(linked.institution_name, "Test Sandbox Bank");
    assert.equal(linked.account_number_mask, "••••6789");

    // Mono delivers at-least-once — the same event can legitimately arrive twice.
    const replay = await postWebhook(payload, { "mono-webhook-secret": "test-webhook-secret" });
    assert.equal(replay.status, 200);

    const rows = await q("SELECT id FROM accounts WHERE mono_account_id = $1", ["mono-acc-1"]);
    assert.equal(rows.length, 1, "a replayed connect event must not create a second wallet");
  });

  test("account_updated imports transactions once each, however many times it is delivered", async () => {
    monoSays({
      "/transactions": {
        data: [
          { id: "mono-tx-1", type: "debit", amount: 250000, narration: "Naivas", date: "2026-08-10" }
        ]
      }
    });

    const payload = {
      event: "mono.events.account_updated",
      data: { id: "mono-acc-1", data_status: "AVAILABLE" }
    };

    const before1 = await one(
      "SELECT balance FROM accounts WHERE mono_account_id = $1", ["mono-acc-1"]
    );

    const first = await postWebhook(payload, { "mono-webhook-secret": "test-webhook-secret" });
    assert.equal(first.status, 200);

    const afterFirst = await one(
      "SELECT balance FROM accounts WHERE mono_account_id = $1", ["mono-acc-1"]
    );
    assert.equal(Number(afterFirst.balance), Number(before1.balance) - 2500);

    const txRows = await q(
      "SELECT * FROM transactions WHERE source = 'mono' AND source_id = 'mono-tx-1'"
    );
    assert.equal(txRows.length, 1);
    assert.equal(txRows[0].kind, "expense");
    assert.equal(Number(txRows[0].amount), 2500);

    // An overlapping sync or a redelivered webhook must not double-post the
    // same bank transaction or move the balance a second time for it.
    const replay = await postWebhook(payload, { "mono-webhook-secret": "test-webhook-secret" });
    assert.equal(replay.status, 200);

    const afterReplay = await one(
      "SELECT balance FROM accounts WHERE mono_account_id = $1", ["mono-acc-1"]
    );
    assert.equal(Number(afterReplay.balance), Number(afterFirst.balance));

    const txRowsAfterReplay = await q(
      "SELECT id FROM transactions WHERE source = 'mono' AND source_id = 'mono-tx-1'"
    );
    assert.equal(txRowsAfterReplay.length, 1, "a replayed event must not duplicate the transaction");
  });

  test("an event naming no user we recognize is acknowledged but links nothing", async () => {
    const res = await postWebhook(
      { event: "mono.events.account_connected", data: { id: "mono-acc-orphan", meta: { ref: "not-one-of-ours" } } },
      { "mono-webhook-secret": "test-webhook-secret" }
    );
    assert.equal(res.status, 200, "an unrecognized payload should not surface as a webhook failure");

    const rows = await q("SELECT id FROM accounts WHERE mono_account_id = $1", ["mono-acc-orphan"]);
    assert.equal(rows.length, 0);
  });
});
