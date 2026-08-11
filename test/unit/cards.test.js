import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CARDS,
  MIN_REDEEM,
  bestCardFor,
  earnRate,
  eligibility,
  limitFor,
  limitIncrease,
  pointsFor,
  pointsMissed,
  pointsStanding,
  upgradePath
} from "../../utils/cards.js";

const card = (id, product, over = {}) => ({
  id,
  product,
  status: "active",
  label: CARDS[product].label,
  credit_limit: 50000,
  ...over
});

const charge = (facility_id, category, amount) => ({ facility_id, category, amount });

describe("what a card earns", () => {
  test("the base rate applies to anything without a category", () => {
    assert.equal(earnRate("gold_card", null), CARDS.gold_card.earn.base);
  });

  test("a bonus category beats the base rate", () => {
    assert.equal(earnRate("gold_card", "Food & Dining"), 3);
    assert.equal(earnRate("gold_card", "Education"), 1);
  });

  test("a category the card has no bonus for falls back to the base", () => {
    assert.equal(earnRate("platinum_card", "Health"), 2);
  });

  test("an unknown product earns nothing", () => {
    assert.equal(earnRate("nonsense", "Food & Dining"), 0);
    assert.equal(pointsFor("nonsense", "Food & Dining", 10000), 0);
  });
});

describe("points on a purchase", () => {
  test("one point per hundred at the base rate", () => {
    assert.equal(pointsFor("secured_card", "Transport", 2500), 25);
  });

  test("the multiplier applies to the points, not the amount", () => {
    assert.equal(pointsFor("gold_card", "Food & Dining", 2500), 75);
  });

  test("the change left over buys nothing — it is floored per purchase", () => {
    assert.equal(pointsFor("secured_card", null, 199), 1);
    assert.equal(pointsFor("secured_card", null, 99), 0);
  });

  test("two purchases are floored apart, not together", () => {
    // 150 + 150 is one point each, not three between them.
    const apart = pointsFor("secured_card", null, 150) + pointsFor("secured_card", null, 150);
    assert.equal(apart, 2);
  });

  test("nothing sensible in, nothing out", () => {
    assert.equal(pointsFor("gold_card", null, 0), 0);
    assert.equal(pointsFor("gold_card", null, -500), 0);
    assert.equal(pointsFor("gold_card", null, "abc"), 0);
  });
});

describe("a card's points balance", () => {
  test("is what was earned less what was taken back", () => {
    const out = pointsStanding(
      "secured_card",
      [charge(1, null, 60000)],
      [{ points: 100 }]
    );
    assert.equal(out.earned, 600);
    assert.equal(out.redeemed, 100);
    assert.equal(out.balance, 500);
    assert.equal(out.worth, 500);
  });

  test("never goes below zero, whatever the redemptions say", () => {
    const out = pointsStanding("secured_card", [], [{ points: 900 }]);
    assert.equal(out.balance, 0);
  });

  test("is not redeemable until it is worth the arithmetic", () => {
    const under = pointsStanding("secured_card", [charge(1, null, (MIN_REDEEM - 1) * 100)], []);
    assert.equal(under.redeemable, false);

    const over = pointsStanding("secured_card", [charge(1, null, MIN_REDEEM * 100)], []);
    assert.equal(over.redeemable, true);
  });
});

describe("which card to reach for", () => {
  const wallet = [card(1, "secured_card"), card(2, "gold_card")];

  test("the one that pays most for the category", () => {
    assert.equal(bestCardFor("Food & Dining", wallet).card.id, 2);
  });

  test("a closed card is not an answer, however good its rate", () => {
    const closed = [card(1, "secured_card"), card(2, "gold_card", { status: "closed" })];
    assert.equal(bestCardFor("Food & Dining", closed).card.id, 1);
  });

  test("no cards, no answer", () => {
    assert.equal(bestCardFor("Food & Dining", []), null);
  });
});

describe("points left on the table", () => {
  const wallet = [card(1, "secured_card"), card(2, "gold_card")];

  test("nothing is lost when the best card was used", () => {
    const out = pointsMissed({ cards: wallet, charges: [charge(2, "Food & Dining", 10000)] });
    assert.equal(out.total, 0);
    assert.deepEqual(out.byCategory, []);
  });

  test("counts the difference and says which card to use instead", () => {
    // 10,000 of food on the secured card earns 100; the gold card would earn 300.
    const out = pointsMissed({ cards: wallet, charges: [charge(1, "Food & Dining", 10000)] });
    assert.equal(out.total, 200);
    assert.equal(out.byCategory[0].category, "Food & Dining");
    assert.equal(out.byCategory[0].use.id, 2);
    assert.equal(out.byCategory[0].spent, 10000);
  });

  test("a category both cards pay the same for costs nothing", () => {
    const out = pointsMissed({ cards: wallet, charges: [charge(1, "Health", 10000)] });
    assert.equal(out.total, 0);
  });

  test("a charge on a card that is not held is ignored rather than guessed at", () => {
    const out = pointsMissed({ cards: wallet, charges: [charge(99, "Food & Dining", 10000)] });
    assert.equal(out.total, 0);
  });

  test("worst category first", () => {
    const out = pointsMissed({
      cards: wallet,
      charges: [charge(1, "Utilities", 10000), charge(1, "Food & Dining", 10000)]
    });
    assert.equal(out.byCategory[0].category, "Food & Dining");
  });
});

describe("what limit a card carries", () => {
  test("months of income, by the card's own multiple", () => {
    assert.equal(limitFor({ product: "gold_card", monthlyIncome: 80000 }), 80000);
    assert.equal(limitFor({ product: "rewards_card", monthlyIncome: 80000 }), 40000);
  });

  test("a clean run raises it by a fifth every six months", () => {
    assert.equal(limitFor({ product: "gold_card", monthlyIncome: 80000, cleanMonths: 6 }), 96000);
    assert.equal(limitFor({ product: "gold_card", monthlyIncome: 80000, cleanMonths: 12 }), 112000);
  });

  test("and stops at twice the starting figure", () => {
    assert.equal(limitFor({ product: "gold_card", monthlyIncome: 80000, cleanMonths: 120 }), 160000);
  });

  test("a secured card takes none of this — its limit is the deposit", () => {
    assert.equal(limitFor({ product: "secured_card", monthlyIncome: 80000, cleanMonths: 24 }), 0);
  });
});

describe("raising a limit already held", () => {
  test("offered when income and a clean record support more", () => {
    const out = limitIncrease({
      facility: card(1, "gold_card", { credit_limit: 50000 }),
      monthlyIncome: 80000,
      cleanMonths: 6
    });
    assert.equal(out.eligible, true);
    assert.equal(out.entitled, 96000);
    assert.equal(out.raise, 46000);
  });

  test("refused when the rise would not be worth having", () => {
    const out = limitIncrease({
      facility: card(1, "gold_card", { credit_limit: 79000 }),
      monthlyIncome: 80000,
      cleanMonths: 0
    });
    assert.equal(out.eligible, false);
    assert.match(out.reason, /six clean months/i);
  });

  test("a secured card is told to add to the deposit instead", () => {
    const out = limitIncrease({
      facility: card(1, "secured_card", { credit_limit: 10000 }),
      monthlyIncome: 80000,
      cleanMonths: 24
    });
    assert.equal(out.eligible, false);
    assert.match(out.reason, /deposit/i);
  });
});

describe("who may hold which card", () => {
  const clean = { onTime: 12, late: 0, missed: 0, due: 12 };
  const base = { score: 75, historyMonths: 8, cleanMonths: 8, record: clean, held: [], monthlyIncome: 80000 };

  test("the secured card asks for nothing but the deposit", () => {
    const out = eligibility("secured_card", { ...base, score: null, historyMonths: 0, monthlyIncome: 0 });
    assert.equal(out.eligible, true);
  });

  test("a card already held is not offered again", () => {
    const out = eligibility("gold_card", { ...base, held: [card(1, "gold_card")] });
    assert.equal(out.eligible, false);
    assert.equal(out.held, true);
  });

  test("no income means no limit to set", () => {
    const out = eligibility("gold_card", { ...base, monthlyIncome: 0 });
    assert.equal(out.eligible, false);
    assert.match(out.reason, /no income/i);
  });

  test("no record at all points at the secured card", () => {
    const out = eligibility("gold_card", { ...base, score: null });
    assert.equal(out.eligible, false);
    assert.match(out.reason, /secured card/i);
  });

  test("a decline names the number that stopped it", () => {
    const short = eligibility("platinum_card", base);
    assert.equal(short.eligible, false);
    assert.match(short.reason, /85/);
    assert.match(short.reason, /75/);
  });

  test("history is a separate gate from the score", () => {
    const out = eligibility("gold_card", { ...base, score: 90, historyMonths: 2, cleanMonths: 2 });
    assert.equal(out.eligible, false);
    assert.match(out.reason, /6 months of history/);
  });

  test("a missed payment closes the top of the range", () => {
    const out = eligibility("platinum_card", {
      ...base,
      score: 90,
      historyMonths: 24,
      cleanMonths: 24,
      record: { onTime: 20, late: 0, missed: 1, due: 21 }
    });
    assert.equal(out.eligible, false);
    assert.match(out.reason, /nothing missed/i);
  });

  test("clearing every gate comes with the limit it would carry", () => {
    const out = eligibility("gold_card", base);
    assert.equal(out.eligible, true);
    assert.equal(out.limit, limitFor({ product: "gold_card", monthlyIncome: 80000, cleanMonths: 8 }));
  });
});

describe("the way up", () => {
  const clean = { onTime: 12, late: 0, missed: 0, due: 12 };

  test("offers the best within reach and names the nearest that is not", () => {
    const path = upgradePath({
      score: 75,
      historyMonths: 8,
      cleanMonths: 8,
      record: clean,
      held: [card(1, "secured_card")],
      monthlyIncome: 80000
    });
    assert.equal(path.held, "secured_card");
    assert.equal(path.offer.product, "gold_card");
    assert.equal(path.next.product, "platinum_card");
  });

  test("the target is the nearest one out of reach, not the grandest", () => {
    const path = upgradePath({
      score: 40,
      historyMonths: 1,
      cleanMonths: 1,
      record: clean,
      held: [card(1, "secured_card")],
      monthlyIncome: 80000
    });
    assert.equal(path.offer, null);
    assert.equal(path.next.product, "rewards_card");
  });

  test("nothing below what is already held is ever offered", () => {
    const path = upgradePath({
      score: 95,
      historyMonths: 24,
      cleanMonths: 24,
      record: clean,
      held: [card(1, "platinum_card")],
      monthlyIncome: 80000
    });
    assert.equal(path.offer, null);
    assert.equal(path.next, null);
  });
});
