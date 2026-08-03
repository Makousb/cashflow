import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  getReview,
  listReviews,
  looseEntries,
  recategoriseTransaction,
  saveReview
} from "../../db/queries/accountant.js";
import { addBusinessTransaction } from "../../db/queries/business.js";
import { reviewLedger, taxPosition } from "../../utils/accounting.js";
import {
  closePool,
  dropUser,
  makeBusiness,
  makeUser,
  one,
  q,
  skipWithoutDb
} from "./helpers.js";

describe("entries the accountant wants filed", { skip: skipWithoutDb }, () => {
  let user;
  let shop;

  before(async () => {
    user = await makeUser("loose");
    shop = await makeBusiness(user.id, "Loose Books");
    const post = (category, note) =>
      addBusinessTransaction({
        businessId: shop.id, userId: user.id, kind: "expense", amount: 1000,
        category, note, occurredOn: "2026-05-01"
      });
    await post("Rent", "May rent");
    await post("Other", "something");
    await post("Uncategorized", "no idea");
    await post("", "blank");
  });

  after(async () => { await dropUser(user?.id); });

  test("finds every flavour of catch-all", async () => {
    const loose = await looseEntries(shop.id, user.id);
    assert.equal(loose.length, 3);
    assert.ok(!loose.some((e) => e.category === "Rent"));
  });

  test("filing one takes it off the list", async () => {
    const loose = await looseEntries(shop.id, user.id);
    const updated = await recategoriseTransaction({
      id: loose[0].id, businessId: shop.id, userId: user.id, category: "Utilities"
    });
    assert.equal(updated.category, "Utilities");
    assert.equal((await looseEntries(shop.id, user.id)).length, 2);
  });

  test("will not touch another business's books", async () => {
    const other = await makeUser("loose-other");
    const theirs = await makeBusiness(other.id, "Someone Else");
    const loose = await looseEntries(shop.id, user.id);

    const asOtherUser = await recategoriseTransaction({
      id: loose[0].id, businessId: shop.id, userId: other.id, category: "Rent"
    });
    assert.equal(asOtherUser, null, "another user must not file this entry");

    const asOtherBusiness = await recategoriseTransaction({
      id: loose[0].id, businessId: theirs.id, userId: user.id, category: "Rent"
    });
    assert.equal(asOtherBusiness, null, "the entry belongs to a different business");

    const untouched = await one("SELECT category FROM business_transactions WHERE id = $1", [loose[0].id]);
    assert.notEqual(untouched.category, "Rent");
    await dropUser(other.id);
  });
});

describe("the record of each review", { skip: skipWithoutDb }, () => {
  let user;
  let shop;

  before(async () => {
    user = await makeUser("reviews");
    shop = await makeBusiness(user.id, "Reviewed Books");
  });

  after(async () => { await dropUser(user?.id); });

  const store = (extra = {}) => {
    const tax = taxPosition({ accrualProfit: 100000, rate: 30, setAside: 10000 });
    const review = reviewLedger({
      transactions: [{ id: 1, kind: "expense", amount: 900, category: "Other", occurred_on: "2026-05-01" }],
      tax, today: "2026-05-10"
    });
    return saveReview({
      businessId: shop.id, userId: user.id, counts: review.counts, tax,
      narrative: "Two things to fix.", mode: "offline", findings: review.findings, ...extra
    });
  };

  test("stores the figures alongside the findings", async () => {
    const saved = await store();
    assert.equal(Number(saved.taxable_profit), 100000);
    assert.equal(Number(saved.tax_owed), 30000);
    assert.equal(Number(saved.tax_shortfall), 20000);
    assert.ok(saved.findings_total >= 2);
  });

  test("keeps the findings exactly as they were written", async () => {
    const saved = await store();
    const read = await getReview(saved.id, user.id);
    assert.ok(Array.isArray(read.findings));
    const codes = read.findings.map((f) => f.code);
    assert.ok(codes.includes("uncategorised"));
    assert.ok(codes.includes("tax-shortfall"));
    // Reading a past review must not recompute it against today's books.
    assert.equal(read.narrative, "Two things to fix.");
  });

  test("lists newest first", async () => {
    await store();
    const history = await listReviews(shop.id, user.id);
    assert.ok(history.length >= 3);
    const times = history.map((r) => new Date(r.created_at).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
  });

  test("is not readable by another user", async () => {
    const saved = await store();
    const other = await makeUser("reviews-other");
    assert.equal(await getReview(saved.id, other.id), null);
    await dropUser(other.id);
  });

  test("goes away with the business", async () => {
    const doomed = await makeBusiness(user.id, "Short Lived");
    const tax = taxPosition({ accrualProfit: 1, rate: 1 });
    const saved = await saveReview({
      businessId: doomed.id, userId: user.id, counts: { total: 0, high: 0 },
      tax, narrative: "clean", mode: "offline", findings: []
    });
    await q("DELETE FROM businesses WHERE id = $1", [doomed.id]);
    assert.equal(await getReview(saved.id, user.id), null);
  });
});

// One teardown for the whole file — every suite in it shares the same pool.
after(async () => {
  await closePool();
});
