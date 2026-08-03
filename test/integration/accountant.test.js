import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  businessesDueForReview,
  claimMonthlyReview,
  getReview,
  listReviews,
  looseEntries,
  recategoriseTransaction,
  recordNotification,
  releaseMonthlyReview,
  saveReview,
  setAutoReview,
  setReviewEmail
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

describe("the monthly close", { skip: skipWithoutDb }, () => {
  let user;
  let shop;

  before(async () => {
    user = await makeUser("monthly");
    shop = await makeBusiness(user.id, "Monthly Books");
  });

  after(async () => { await dropUser(user?.id); });

  const claimed = () => claimMonthlyReview(shop.id);
  const reload = async () =>
    one("SELECT auto_review, last_auto_review FROM businesses WHERE id = $1", [shop.id]);

  test("a business that has not opted in is never claimed", async () => {
    assert.equal(await claimed(), false);
  });

  test("opting in makes it claimable", async () => {
    await setAutoReview(shop.id, user.id, true);
    assert.equal((await reload()).auto_review, true);
    assert.equal(await claimed(), true);
  });

  test("the claim records the month, not the day", async () => {
    const { last_auto_review: month } = await reload();
    assert.equal(new Date(month).getDate(), 1);
  });

  test("it cannot be claimed twice in the same month", async () => {
    assert.equal(await claimed(), false);
    assert.equal(await claimed(), false);
  });

  test("two requests racing produce exactly one claim", async () => {
    // The whole reason the claim is a conditional UPDATE rather than a read
    // followed by a write.
    await q("UPDATE businesses SET last_auto_review = NULL WHERE id = $1", [shop.id]);
    const results = await Promise.all([claimed(), claimed(), claimed(), claimed(), claimed()]);
    assert.equal(results.filter(Boolean).length, 1);
  });

  test("a new month can be claimed again", async () => {
    await q(
      "UPDATE businesses SET last_auto_review = date_trunc('month', CURRENT_DATE)::date - INTERVAL '1 month' WHERE id = $1",
      [shop.id]
    );
    assert.equal(await claimed(), true);
  });

  test("skipped months are not caught up — one close, not three", async () => {
    await q(
      "UPDATE businesses SET last_auto_review = date_trunc('month', CURRENT_DATE)::date - INTERVAL '3 months' WHERE id = $1",
      [shop.id]
    );
    assert.equal(await claimed(), true, "the current month is claimed");
    assert.equal(await claimed(), false, "and that is the only one");
  });

  test("releasing a failed run lets it be retried", async () => {
    await q("UPDATE businesses SET last_auto_review = NULL WHERE id = $1", [shop.id]);
    assert.equal(await claimed(), true);
    assert.equal(await claimed(), false);
    await releaseMonthlyReview(shop.id, null);
    assert.equal(await claimed(), true, "the month is available again after a failure");
  });

  test("opting out stops it being claimed", async () => {
    await q("UPDATE businesses SET last_auto_review = NULL WHERE id = $1", [shop.id]);
    await setAutoReview(shop.id, user.id, false);
    assert.equal(await claimed(), false);
  });

  test("only businesses that are due are listed", async () => {
    await setAutoReview(shop.id, user.id, true);
    await q("UPDATE businesses SET last_auto_review = NULL WHERE id = $1", [shop.id]);
    assert.equal((await businessesDueForReview(user.id)).some((b) => b.id === shop.id), true);
    await claimed();
    assert.equal((await businessesDueForReview(user.id)).some((b) => b.id === shop.id), false);
  });

  test("another user cannot switch it on", async () => {
    const other = await makeUser("monthly-other");
    assert.equal(await setAutoReview(shop.id, other.id, false), null);
    assert.equal((await reload()).auto_review, true, "unchanged");
    await dropUser(other.id);
  });
});

describe("who gets told", { skip: skipWithoutDb }, () => {
  let user;
  let shop;

  before(async () => {
    user = await makeUser("notify");
    shop = await makeBusiness(user.id, "Notified Books");
  });

  after(async () => { await dropUser(user?.id); });

  const reload = async () =>
    one("SELECT review_email FROM businesses WHERE id = $1", [shop.id]);

  test("nobody, until an address is set", async () => {
    assert.equal((await reload()).review_email, null);
  });

  test("an address can be set", async () => {
    await setReviewEmail(shop.id, user.id, "books@example.com");
    assert.equal((await reload()).review_email, "books@example.com");
  });

  test("clearing it stops the notification", async () => {
    await setReviewEmail(shop.id, user.id, "");
    assert.equal((await reload()).review_email, null, "empty means nobody, not an empty string");
  });

  test("another user cannot redirect it", async () => {
    await setReviewEmail(shop.id, user.id, "books@example.com");
    const other = await makeUser("notify-other");
    assert.equal(await setReviewEmail(shop.id, other.id, "attacker@example.com"), null);
    assert.equal((await reload()).review_email, "books@example.com", "unchanged");
    await dropUser(other.id);
  });

  test("a review records who it was sent to", async () => {
    const tax = taxPosition({ accrualProfit: 1000, rate: 10 });
    const saved = await saveReview({
      businessId: shop.id, userId: user.id, counts: { total: 0, high: 0 },
      tax, narrative: "clean", mode: "offline", findings: []
    });
    assert.equal(saved.notified_to, null, "nothing sent yet");

    const after = await recordNotification(saved.id, "books@example.com");
    assert.equal(after.notified_to, "books@example.com");
    assert.ok(after.notified_at);
  });

  test("an unsent review stays marked unsent", async () => {
    const tax = taxPosition({ accrualProfit: 1000, rate: 10 });
    const saved = await saveReview({
      businessId: shop.id, userId: user.id, counts: { total: 0, high: 0 },
      tax, narrative: "clean", mode: "offline", findings: []
    });
    const history = await listReviews(shop.id, user.id);
    const mine = history.find((r) => r.id === saved.id);
    assert.equal(mine.notified_to, null);
    assert.equal(mine.notified_at, null);
  });
});

// One teardown for the whole file — every suite in it shares the same pool.
after(async () => {
  await closePool();
});
