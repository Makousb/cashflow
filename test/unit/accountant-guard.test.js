// The accounting agent lets a language model propose a category, and that
// proposal ends up in an UPDATE. These tests pin down the guard around it:
// whatever the model returns, only a category this business actually uses, on
// an entry we actually asked about, may come back.
//
// The provider is configured through the environment, which is read when the
// module first loads — hence the assignment before the dynamic import.
process.env.AI_API_KEY = "test-key-not-a-real-one";
process.env.AI_BASE_URL = "https://provider.invalid/v1";
process.env.AI_MODEL = "test-model";

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

const { aiEnabled, narrate, proposeCategories } = await import("../../services/accountant.js");

const ALLOWED = ["Sales", "Rent", "Utilities", "Payroll", "Inventory Purchase", "Transport"];
const BUSINESS = { name: "Test Shop", industry: "Retail" };
const ENTRIES = [
  { id: 11, kind: "expense", amount: 12000, note: "", occurred_on: "2026-05-01" },
  { id: 12, kind: "expense", amount: 3200, note: "", occurred_on: "2026-05-02" }
];

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Stand in for the provider, returning whatever the test wants it to say.
function providerSays(content) {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] })
  });
}

describe("the provider is configured", () => {
  test("aiEnabled sees the environment", () => {
    assert.equal(aiEnabled(), true);
  });
});

describe("proposeCategories only accepts what it can verify", () => {
  test("takes a valid suggestion", async () => {
    providerSays('{"11": "Rent", "12": "Utilities"}');
    const { proposals, mode } = await proposeCategories({
      entries: ENTRIES, allowed: ALLOWED, business: BUSINESS
    });
    assert.equal(proposals.get(11), "Rent");
    assert.equal(proposals.get(12), "Utilities");
    assert.equal(mode, "ai");
  });

  test("drops a category this business does not use", async () => {
    providerSays('{"11": "Entertainment", "12": "Utilities"}');
    const { proposals } = await proposeCategories({
      entries: ENTRIES, allowed: ALLOWED, business: BUSINESS
    });
    assert.equal(proposals.has(11), false, "invented category must not survive");
    assert.equal(proposals.get(12), "Utilities");
  });

  test("drops an entry it was never asked about", async () => {
    providerSays('{"999": "Rent", "12": "Rent"}');
    const { proposals } = await proposeCategories({
      entries: ENTRIES, allowed: ALLOWED, business: BUSINESS
    });
    assert.equal(proposals.has(999), false, "a stray id must not survive");
    assert.equal(proposals.get(12), "Rent");
  });

  test("is not fooled by a category that only looks right", async () => {
    providerSays('{"11": "rent", "12": " Rent "}');
    const { proposals } = await proposeCategories({
      entries: ENTRIES, allowed: ALLOWED, business: BUSINESS
    });
    assert.equal(proposals.size, 0, "matching is exact, not fuzzy");
  });

  test("ignores anything else the model decides to send", async () => {
    providerSays('{"11": "Rent", "__proto__": "Rent", "constructor": "Rent"}');
    const { proposals } = await proposeCategories({
      entries: ENTRIES, allowed: ALLOWED, business: BUSINESS
    });
    assert.equal(proposals.get(11), "Rent");
    assert.equal(proposals.size, 1);
    assert.equal({}.polluted, undefined);
  });

  test("survives prose instead of JSON", async () => {
    providerSays("Sure! Entry 11 is definitely rent.");
    const { proposals, mode } = await proposeCategories({
      entries: ENTRIES, allowed: ALLOWED, business: BUSINESS
    });
    assert.equal(mode, "offline");
    assert.equal(proposals.size, 0);
  });

  test("unwraps a fenced code block, which models like to add", async () => {
    providerSays('```json\n{"11": "Rent"}\n```');
    const { proposals } = await proposeCategories({
      entries: ENTRIES, allowed: ALLOWED, business: BUSINESS
    });
    assert.equal(proposals.get(11), "Rent");
  });

  test("falls back to the built-in rules when the provider errors", async () => {
    globalThis.fetch = async () => { throw new Error("network down"); };
    const { proposals, mode } = await proposeCategories({
      entries: [{ id: 11, kind: "expense", amount: 12000, note: "May rent to landlord", occurred_on: "2026-05-01" }],
      allowed: ALLOWED, business: BUSINESS
    });
    assert.equal(mode, "offline");
    assert.equal(proposals.get(11), "Rent", "the keyword rules still work");
  });

  test("the rules obey the same allow-list", async () => {
    globalThis.fetch = async () => { throw new Error("network down"); };
    const { proposals } = await proposeCategories({
      entries: [{ id: 11, kind: "expense", amount: 500, note: "matatu fare", occurred_on: "2026-05-01" }],
      allowed: ["Rent"], business: BUSINESS
    });
    assert.equal(proposals.size, 0, "Transport is not permitted here, so nothing is proposed");
  });

  test("asks nothing of the provider when there is nothing to file", async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; throw new Error("should not be called"); };
    const { proposals } = await proposeCategories({
      entries: [], allowed: ALLOWED, business: BUSINESS
    });
    assert.equal(proposals.size, 0);
    assert.equal(called, false);
  });
});

describe("the covering note never blocks the review", () => {
  const tax = {
    taxableProfit: 100000, rate: 30, incomeTax: 30000, remittances: 0,
    totalOwed: 30000, setAside: 0, shortfall: 30000, surplus: 0, coverage: 0
  };
  const review = { counts: { total: 1, high: 1, medium: 0, low: 0 },
    findings: [{ severity: "high", title: "T", detail: "D" }] };
  const fmt = (n) => `KSh ${Number(n).toFixed(2)}`;

  test("uses the provider when it answers", async () => {
    providerSays("Two things need doing before month end.");
    const out = await narrate({ business: BUSINESS, tax, review, fmt });
    assert.equal(out.mode, "ai");
    assert.match(out.text, /month end/);
  });

  test("writes its own when the provider fails", async () => {
    globalThis.fetch = async () => { throw new Error("provider exploded"); };
    const out = await narrate({ business: BUSINESS, tax, review, fmt });
    assert.equal(out.mode, "offline");
    assert.match(out.text, /KSh 30,?000\.00|30000\.00/, "the figures still come through");
  });

  test("a refusal from the provider is not treated as a note", async () => {
    globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
    const out = await narrate({ business: BUSINESS, tax, review, fmt });
    assert.equal(out.mode, "offline");
    assert.ok(out.text.length > 0);
  });
});
