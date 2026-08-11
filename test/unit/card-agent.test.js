import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { payDownTo, reviewCards, spendingShape, standingFrom } from "../../utils/card-agent.js";
import { cardStanding } from "../../utils/credit.js";

const TODAY = "2026-08-11";

// A card as the rest of the app hands one over: the facility row with its
// standing worked out by the real cardStanding, so nothing here is testing
// against a shape only this file believes in.
function heldCard({
  id = 1,
  product = "secured_card",
  label = "Everyday card",
  limit = 50000,
  apr = 30,
  openedOn = "2026-06-01",
  charges = [],
  payments = [],
  todayIso = TODAY
} = {}) {
  const facility = {
    id,
    product,
    label,
    apr,
    credit_limit: limit,
    deposit: product === "secured_card" ? limit : null,
    status: "active",
    opened_on: openedOn
  };
  return {
    ...facility,
    installments: [],
    standing: { outstanding: 0 },
    card: cardStanding(facility, charges, payments, todayIso)
  };
}

const charge = (facility_id, charged_on, amount, category = null) => ({
  facility_id, charged_on, amount, category
});

const MEANS = { income: 80000, expenses: 40000, commitments: 0, disposable: 40000 };
const SCORE = {
  score: 72,
  band: "fair",
  parts: [
    { label: "How much of the card you use", max: 20, points: 8, detail: "a lot of the limit is in use" }
  ],
  summary: ""
};

const find = (review, kind) => review.moves.find((m) => m.kind === kind) || null;

describe("what the cards were spent on", () => {
  const charges = [
    charge(1, "2026-06-05", 5000),
    charge(1, "2026-07-10", 8000),
    charge(1, "2026-08-02", 4000, "Food & Dining"),
    charge(1, "2026-08-05", 2000, "Transport")
  ];

  test("this month is only this month", () => {
    assert.equal(spendingShape(charges, TODAY).thisMonth, 6000);
  });

  test("last month is the last one that finished, not the last one recorded", () => {
    assert.equal(spendingShape(charges, TODAY).lastMonth.month, "2026-07");
    assert.equal(spendingShape(charges, TODAY).lastMonth.total, 8000);
  });

  test("the average leaves out the month still running", () => {
    assert.equal(spendingShape(charges, TODAY).average, 6500);
  });

  test("categories are this month's, biggest first", () => {
    const out = spendingShape(charges, TODAY).categories;
    assert.equal(out[0].category, "Food & Dining");
    assert.equal(out[0].total, 4000);
    assert.equal(out[1].category, "Transport");
  });

  test("nothing spent, nothing to say", () => {
    const out = spendingShape([], TODAY);
    assert.equal(out.thisMonth, 0);
    assert.equal(out.lastMonth, null);
    assert.deepEqual(out.categories, []);
  });
});

describe("paying a card back under a line", () => {
  test("is the balance less what the line allows", () => {
    assert.equal(payDownTo({ limit: 50000, balance: 30000 }, 30), 15000);
  });

  test("is nothing when already under it", () => {
    assert.equal(payDownTo({ limit: 50000, balance: 10000 }, 30), 0);
  });
});

describe("where a person stands", () => {
  test("history is counted from the first thing opened", () => {
    const out = standingFrom({
      facilities: [heldCard({ openedOn: "2026-05-01" })],
      monthlyIncome: 80000,
      todayIso: TODAY
    });
    assert.equal(out.historyMonths, 3);
  });

  test("with nothing missed, every month of it is clean", () => {
    const out = standingFrom({
      facilities: [heldCard({ openedOn: "2026-05-01" })],
      monthlyIncome: 80000,
      todayIso: TODAY
    });
    assert.equal(out.cleanMonths, out.historyMonths);
    assert.equal(out.lastSlip, null);
  });

  test("a missed statement resets the clean run to the day it happened", () => {
    const out = standingFrom({
      facilities: [
        heldCard({
          openedOn: "2026-05-01",
          charges: [charge(1, "2026-05-10", 20000)],
          todayIso: "2026-08-25"
        })
      ],
      monthlyIncome: 80000,
      todayIso: "2026-08-25"
    });
    assert.equal(out.cleanMonths, 0);
    assert.equal(out.lastSlip, "2026-08-21");
  });

  test("an instalment paid after its date is a slip too", () => {
    const out = standingFrom({
      facilities: [{
        id: 9,
        product: "bnpl",
        status: "settled",
        opened_on: "2026-03-01",
        installments: [{ due_on: "2026-04-01", paid_on: "2026-04-09", amount: 100 }],
        standing: { outstanding: 0 }
      }],
      monthlyIncome: 80000,
      todayIso: TODAY
    });
    assert.equal(out.lastSlip, "2026-04-09");
    assert.equal(out.record.late, 1);
  });

  test("utilisation is across every card, not whichever came back first", () => {
    const out = standingFrom({
      facilities: [
        heldCard({ id: 1, limit: 50000, charges: [charge(1, "2026-08-01", 5000)] }),
        heldCard({ id: 2, limit: 50000, charges: [charge(2, "2026-08-01", 15000)] })
      ],
      monthlyIncome: 80000,
      todayIso: TODAY
    });
    assert.equal(out.limit, 100000);
    assert.equal(out.balance, 20000);
    assert.equal(out.utilisation, 20);
  });

  test("no cards at all leaves utilisation unscored rather than perfect", () => {
    const out = standingFrom({ facilities: [], monthlyIncome: 80000, todayIso: TODAY });
    assert.equal(out.utilisation, null);
  });
});

describe("the agent on a statement that is due", () => {
  // Charged in July, so July's statement is drawn and falls due on 21 August.
  const cards = [heldCard({ charges: [charge(1, "2026-07-05", 20000)] })];
  const review = reviewCards({
    cards,
    means: MEANS,
    score: SCORE,
    charges: [charge(1, "2026-07-05", 20000)],
    settings: {},
    accounts: [],
    todayIso: TODAY
  });

  test("says what is due, by when, and offers to pay it", () => {
    const move = find(review, "due");
    assert.ok(move);
    assert.equal(move.action.kind, "pay");
    assert.equal(move.amount, cards[0].card.minimumDue);
    assert.match(move.title, /2026-08-21/);
  });

  test("is not urgent while there is still time to pay it", () => {
    assert.equal(find(review, "due").severity, "medium");
  });

  test("offers clearing the whole card as the alternative", () => {
    assert.equal(find(review, "due").alternative.amount, cards[0].card.balance);
  });

  test("and says nothing about a missed one, because none was", () => {
    assert.equal(find(review, "missed"), null);
  });
});

describe("the agent on a statement that was missed", () => {
  const charges = [charge(1, "2026-07-05", 20000)];
  const review = reviewCards({
    cards: [heldCard({ charges, todayIso: "2026-08-25" })],
    means: MEANS,
    score: SCORE,
    charges,
    settings: {},
    accounts: [],
    todayIso: "2026-08-25"
  });

  test("raises it as the most urgent thing there is", () => {
    const move = find(review, "missed");
    assert.ok(move);
    assert.equal(move.severity, "high");
    assert.equal(review.moves[0].kind, "missed");
  });

  test("and the whole run is at risk because of it", () => {
    assert.equal(review.health, "at risk");
    assert.equal(review.counts.high >= 1, true);
  });
});

describe("the agent on a card near its limit", () => {
  const charges = [charge(1, "2026-08-01", 41000)];
  const review = reviewCards({
    cards: [heldCard({ charges })],
    means: MEANS,
    score: SCORE,
    charges,
    settings: {},
    accounts: [],
    todayIso: TODAY
  });

  test("says how much to pay to get back under the line", () => {
    const move = find(review, "maxed");
    assert.ok(move);
    // 41,000 owed against a 50,000 limit; 30% of it is 15,000.
    assert.equal(move.amount, 26000);
    assert.equal(move.action.kind, "pay");
  });

  test("over the line but not near it is worth doing, not urgent", () => {
    // 41,000 of 50,000 is 82% — over the 30% line, well short of maxed.
    assert.equal(find(review, "maxed").severity, "medium");
  });

  test("a card past nine tenths of its limit is urgent, not a suggestion", () => {
    const nearly = [charge(1, "2026-08-01", 46000)];
    const out = reviewCards({
      cards: [heldCard({ charges: nearly })],
      means: MEANS,
      score: SCORE,
      charges: nearly,
      settings: {},
      accounts: [],
      todayIso: TODAY
    });
    const move = find(out, "maxed");
    assert.equal(move.severity, "high");
    assert.match(move.title, /maxed out/);
  });

  test("a card comfortably under the line is not mentioned at all", () => {
    const quiet = [charge(1, "2026-08-01", 5000)];
    const out = reviewCards({
      cards: [heldCard({ charges: quiet })],
      means: MEANS,
      score: SCORE,
      charges: quiet,
      settings: {},
      accounts: [],
      todayIso: TODAY
    });
    assert.equal(find(out, "maxed"), null);
  });

  test("the holder's own line is what is enforced, not the default", () => {
    const some = [charge(1, "2026-08-01", 6000)];
    const out = reviewCards({
      cards: [heldCard({ charges: some })],
      means: MEANS,
      score: SCORE,
      charges: some,
      settings: { utilisation_target: 10 },
      accounts: [],
      todayIso: TODAY
    });
    assert.equal(find(out, "maxed").amount, 1000);
  });
});

describe("the agent on autopay it cannot make", () => {
  const charges = [charge(1, "2026-07-05", 20000)];
  const settings = { autopay: "minimum", autopay_account_id: 7, lead_days: 3 };

  test("says so when the chosen wallet will not cover it", () => {
    const out = reviewCards({
      cards: [heldCard({ charges })],
      means: MEANS,
      score: SCORE,
      charges,
      settings,
      accounts: [{ id: 7, name: "M-Pesa", balance: 100 }],
      // Two days before the date, so the payment is imminent.
      todayIso: "2026-08-19"
    });
    const move = find(out, "autopay_short");
    assert.ok(move);
    assert.equal(move.severity, "high");
    assert.match(move.title, /M-Pesa/);
  });

  test("and when no wallet was ever chosen", () => {
    const out = reviewCards({
      cards: [heldCard({ charges })],
      means: MEANS,
      score: SCORE,
      charges,
      settings: { ...settings, autopay_account_id: null },
      accounts: [],
      todayIso: "2026-08-19"
    });
    assert.match(find(out, "autopay_short").title, /no wallet/i);
  });

  test("says nothing while the date is still far off", () => {
    const out = reviewCards({
      cards: [heldCard({ charges })],
      means: MEANS,
      score: SCORE,
      charges,
      settings,
      accounts: [{ id: 7, name: "M-Pesa", balance: 100 }],
      todayIso: TODAY
    });
    assert.equal(find(out, "autopay_short"), null);
  });

  test("a wallet that covers it is not a problem", () => {
    const out = reviewCards({
      cards: [heldCard({ charges })],
      means: MEANS,
      score: SCORE,
      charges,
      settings,
      accounts: [{ id: 7, name: "M-Pesa", balance: 90000 }],
      todayIso: "2026-08-19"
    });
    assert.equal(find(out, "autopay_short"), null);
  });
});

describe("the agent on spending habits", () => {
  test("card spending beyond what is spare is raised as urgent", () => {
    const charges = [charge(1, "2026-08-02", 30000)];
    const out = reviewCards({
      cards: [heldCard({ limit: 200000, charges })],
      means: { income: 80000, expenses: 70000, commitments: 0, disposable: 10000 },
      score: SCORE,
      charges,
      settings: {},
      accounts: [],
      todayIso: TODAY
    });
    const move = find(out, "overspend");
    assert.ok(move);
    assert.equal(move.severity, "high");
  });

  test("a month running well ahead of the last one is worth saying", () => {
    const charges = [charge(1, "2026-07-04", 4000), charge(1, "2026-08-02", 9000)];
    const out = reviewCards({
      cards: [heldCard({ limit: 200000, charges })],
      means: MEANS,
      score: SCORE,
      charges,
      settings: {},
      accounts: [],
      todayIso: TODAY
    });
    assert.match(find(out, "pace").title, /125%/);
  });

  test("a month in line with the last one is not", () => {
    const charges = [charge(1, "2026-07-04", 9000), charge(1, "2026-08-02", 9000)];
    const out = reviewCards({
      cards: [heldCard({ limit: 200000, charges })],
      means: MEANS,
      score: SCORE,
      charges,
      settings: {},
      accounts: [],
      todayIso: TODAY
    });
    assert.equal(find(out, "pace"), null);
  });

  test("one category dominating the month gets named", () => {
    const charges = [
      charge(1, "2026-08-02", 9000, "Food & Dining"),
      charge(1, "2026-08-03", 1000, "Transport")
    ];
    const out = reviewCards({
      cards: [heldCard({ limit: 200000, charges })],
      means: MEANS,
      score: SCORE,
      charges,
      settings: {},
      accounts: [],
      todayIso: TODAY
    });
    assert.match(find(out, "hot_category").title, /Food & Dining/);
  });
});

describe("the agent on points", () => {
  test("names the card that should have been used, and what it cost", () => {
    const charges = [charge(1, "2026-08-02", 10000, "Food & Dining")];
    const out = reviewCards({
      cards: [
        heldCard({ id: 1, limit: 200000, charges }),
        heldCard({ id: 2, product: "gold_card", label: "Gold", limit: 200000, apr: 18 })
      ],
      means: MEANS,
      score: SCORE,
      charges,
      settings: {},
      accounts: [],
      todayIso: TODAY
    });
    const move = find(out, "points_missed");
    assert.ok(move);
    assert.equal(move.hint[0].use, "Gold");
    assert.equal(move.hint[0].category, "Food & Dining");
  });

  test("offers to redeem once there are enough of them to take", () => {
    const charges = [charge(1, "2026-08-02", 60000)];
    const out = reviewCards({
      cards: [heldCard({ limit: 200000, charges })],
      means: MEANS,
      score: SCORE,
      charges,
      settings: {},
      accounts: [],
      todayIso: TODAY
    });
    const move = find(out, "points_ready");
    assert.ok(move);
    assert.equal(move.action.kind, "redeem");
    assert.equal(move.action.points, 600);
  });

  test("counts what has already been redeemed against the balance", () => {
    const charges = [charge(1, "2026-08-02", 60000)];
    const out = reviewCards({
      cards: [heldCard({ limit: 200000, charges })],
      means: MEANS,
      score: SCORE,
      charges,
      redemptionsByFacility: new Map([[1, [{ points: 500 }]]]),
      settings: {},
      accounts: [],
      todayIso: TODAY
    });
    assert.equal(out.points.balance, 100);
    assert.equal(find(out, "points_ready"), null);
  });
});

describe("the agent on a better card", () => {
  test("offers one when the record has earned it", () => {
    const out = reviewCards({
      cards: [heldCard({ openedOn: "2025-06-01" })],
      means: MEANS,
      score: { score: 90, band: "strong", parts: [], summary: "" },
      record: { onTime: 12, late: 0, missed: 0, due: 12 },
      historyMonths: 14,
      cleanMonths: 14,
      charges: [],
      settings: {},
      accounts: [],
      todayIso: TODAY
    });
    const move = find(out, "upgrade");
    assert.ok(move);
    assert.equal(move.action.kind, "apply");
    assert.equal(move.action.product, "platinum_card");
  });

  test("and names the next one up with what is missing when it has not", () => {
    const out = reviewCards({
      cards: [heldCard()],
      means: MEANS,
      score: { score: 40, band: "shaky", parts: [], summary: "" },
      record: { onTime: 2, late: 0, missed: 0, due: 2 },
      historyMonths: 2,
      cleanMonths: 2,
      charges: [],
      settings: {},
      accounts: [],
      todayIso: TODAY
    });
    assert.equal(find(out, "upgrade"), null);
    assert.match(find(out, "upgrade_target").title, /rewards card/i);
  });
});

describe("the agent with nothing to work with", () => {
  const out = reviewCards({
    cards: [],
    means: MEANS,
    score: { score: null, band: "not enough history", parts: [], summary: "" },
    charges: [],
    settings: {},
    accounts: [],
    todayIso: TODAY
  });

  test("points at the secured card rather than saying nothing", () => {
    assert.ok(find(out, "no_card"));
  });

  test("and nothing it says is urgent, because nothing is wrong", () => {
    assert.equal(out.counts.high, 0);
    assert.equal(out.health, "on track");
  });
});

describe("the ordering of what to do", () => {
  test("what is going wrong comes before what could be better", () => {
    const charges = [charge(1, "2026-07-05", 45000)];
    const out = reviewCards({
      cards: [heldCard({ charges, todayIso: "2026-08-25" })],
      means: MEANS,
      score: SCORE,
      charges,
      settings: {},
      accounts: [],
      todayIso: "2026-08-25"
    });
    const kinds = out.moves.map((m) => m.kind);
    assert.equal(kinds[0], "missed");
    assert.ok(kinds.indexOf("maxed") < kinds.indexOf("score"));
  });
});
