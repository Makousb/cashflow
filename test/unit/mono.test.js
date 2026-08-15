// services/mono.js reads config.mono at call time via config/env.js, which
// reads process.env once at import — same reason accountant-guard.test.js
// sets its provider env vars before the dynamic import.
process.env.MONO_SECRET_KEY = "test-sec-key-not-real";

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

const { initiateLink, listTransactions, makeLinkRef, userIdFromRef } =
  await import("../../services/mono.js");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function fetchReturns(body) {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => body
  });
}

describe("link ref round-trips a user id with no lookup table needed", () => {
  test("userIdFromRef reads back what makeLinkRef encoded", () => {
    const ref = makeLinkRef(42);
    assert.match(ref, /^u42-[0-9a-f]{12}$/);
    assert.equal(userIdFromRef(ref), 42);
  });

  test("a ref that isn't ours decodes to null rather than throwing", () => {
    assert.equal(userIdFromRef("not-a-ref-at-all"), null);
    assert.equal(userIdFromRef(""), null);
    assert.equal(userIdFromRef(undefined), null);
  });
});

describe("initiateLink", () => {
  test("returns the hosted URL Mono hands back, tagged with our ref", async () => {
    fetchReturns({ data: { mono_url: "https://link.mono.co/abc123" } });
    const { monoUrl, ref } = await initiateLink({
      userId: 7, name: "Demo User", email: "demo@cashflow.local",
      redirectUrl: "http://localhost:3001/accounts/mono/redirect"
    });
    assert.equal(monoUrl, "https://link.mono.co/abc123");
    assert.equal(userIdFromRef(ref), 7);
  });

  test("a response with no mono_url is a hard failure, not a silent redirect to nowhere", async () => {
    fetchReturns({ data: {} });
    await assert.rejects(
      () => initiateLink({ userId: 1, name: "A", email: "a@example.test", redirectUrl: "x" }),
      /did not return a linking URL/
    );
  });
});

describe("listTransactions normalizes Mono's shape into this app's own", () => {
  test("minor units become major units and debit/credit become expense/income", async () => {
    fetchReturns({
      data: [
        { id: "tx_1", type: "debit", amount: 450000, narration: "Naivas Supermarket", date: "2026-08-10" },
        { id: "tx_2", type: "credit", amount: 8500000, narration: "Salary", date: "2026-08-05" }
      ]
    });
    const rows = await listTransactions("mono-acc-1");
    assert.deepEqual(rows[0], {
      sourceId: "tx_1", kind: "expense", amount: 4500, note: "Naivas Supermarket", occurredOn: "2026-08-10"
    });
    assert.deepEqual(rows[1], {
      sourceId: "tx_2", kind: "income", amount: 85000, note: "Salary", occurredOn: "2026-08-05"
    });
  });

  test("an empty account has an empty history, not an error", async () => {
    fetchReturns({ data: [] });
    const rows = await listTransactions("mono-acc-empty");
    assert.deepEqual(rows, []);
  });
});
