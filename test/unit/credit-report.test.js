import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { creditReport, creditScore, paymentRecord } from "../../utils/credit-report.js";

const TODAY = "2026-08-07";

const installment = (due_on, paid_on = null) => ({ due_on, paid_on, amount: 100 });
const statement = (dueOn, over = {}) => ({
  cycle: dueOn.slice(0, 7), dueOn, minimumDue: 50, met: false, missed: false, ...over
});

describe("the payment record", () => {
  test("counts an instalment paid by its date as on time", () => {
    const out = paymentRecord(
      [{ installments: [installment("2026-03-10", "2026-03-09")] }], 2026, TODAY
    );
    assert.deepEqual(out, { onTime: 1, late: 0, missed: 0, due: 1 });
  });

  test("paid on the day itself is on time, not late", () => {
    const out = paymentRecord(
      [{ installments: [installment("2026-03-10", "2026-03-10")] }], 2026, TODAY
    );
    assert.equal(out.onTime, 1);
    assert.equal(out.late, 0);
  });

  test("paid after it is late, and unpaid past it is missed", () => {
    const out = paymentRecord([{
      installments: [
        installment("2026-03-10", "2026-03-11"),
        installment("2026-04-10")
      ]
    }], 2026, TODAY);
    assert.equal(out.late, 1);
    assert.equal(out.missed, 1);
  });

  test("something still ahead of its date is neither", () => {
    const out = paymentRecord(
      [{ installments: [installment("2026-12-10")] }], 2026, TODAY
    );
    assert.deepEqual(out, { onTime: 0, late: 0, missed: 0, due: 0 });
  });

  test("card statements count alongside instalments", () => {
    const out = paymentRecord([{
      installments: [installment("2026-03-10", "2026-03-09")],
      card: { statements: [statement("2026-04-21", { met: true }), statement("2026-05-21", { missed: true })] }
    }], 2026, TODAY);
    assert.equal(out.onTime, 2);
    assert.equal(out.missed, 1);
    assert.equal(out.due, 3);
  });

  test("a statement that asked for nothing is not a payment anybody made", () => {
    // Met on sight, because nothing was owed. Counting it would pad the record
    // with payments that never happened.
    const out = paymentRecord([{
      card: { statements: [statement("2026-04-21", { minimumDue: 0, met: true })] }
    }], 2026, TODAY);
    assert.equal(out.due, 0);
  });

  test("another year's payments are another year's problem", () => {
    const out = paymentRecord([{
      installments: [installment("2025-03-10"), installment("2026-03-10", "2026-03-01")]
    }], 2026, TODAY);
    assert.equal(out.due, 1);
    assert.equal(out.onTime, 1);
  });
});

describe("the score", () => {
  const perfect = { onTime: 12, late: 0, missed: 0, due: 12 };

  test("is not invented when there is nothing to go on", () => {
    const out = creditScore({ record: { onTime: 0, late: 0, missed: 0, due: 0 } });
    assert.equal(out.score, null);
    assert.equal(out.band, "not enough history");
    assert.match(out.summary, /nothing to score/);
  });

  test("is full marks when every part is", () => {
    const out = creditScore({
      record: perfect, utilisation: 0, owed: 0, monthlyIncome: 50000, historyMonths: 12
    });
    assert.equal(out.score, 100);
    assert.equal(out.band, "strong");
  });

  test("counts only the parts that apply, so no card is not a mark against you", () => {
    // Same record, one with a card at nought used and one with no card at all.
    // Both are doing everything right, so both should say so.
    const withCard = creditScore({
      record: perfect, utilisation: 0, owed: 0, monthlyIncome: 50000, historyMonths: 12
    });
    const without = creditScore({
      record: perfect, utilisation: null, owed: 0, monthlyIncome: 50000, historyMonths: 12
    });
    assert.equal(withCard.score, without.score);
    assert.equal(without.parts.length, 3);
  });

  test("missed payments are what move it most", () => {
    const half = creditScore({
      record: { onTime: 6, late: 0, missed: 6, due: 12 },
      utilisation: 0, owed: 0, monthlyIncome: 50000, historyMonths: 12
    });
    // Half of the fifty points for paying on time, out of a hundred available.
    assert.equal(half.score, 75);
    assert.match(half.parts[0].detail, /6 of 12 payments arrived on time/);
    assert.match(half.parts[0].detail, /6 did not arrive at all/);
  });

  test("a late payment is not an on-time one", () => {
    const out = creditScore({
      record: { onTime: 11, late: 1, missed: 0, due: 12 },
      utilisation: 0, owed: 0, monthlyIncome: 50000, historyMonths: 12
    });
    assert.ok(out.score < 100);
    assert.match(out.parts[0].detail, /1 arrived late/);
  });

  test("using the whole limit costs the whole of that part", () => {
    const out = creditScore({
      record: perfect, utilisation: 100, owed: 0, monthlyIncome: 50000, historyMonths: 12
    });
    const used = out.parts.find((p) => p.label.startsWith("How much of the card"));
    assert.equal(used.points, 0);
    assert.equal(used.max, 20);
  });

  test("owing three months of income costs the whole of that part", () => {
    const out = creditScore({
      record: perfect, utilisation: 0, owed: 150000, monthlyIncome: 50000, historyMonths: 12
    });
    const owed = out.parts.find((p) => p.label.startsWith("What you owe"));
    assert.equal(owed.points, 0);
    assert.match(owed.detail, /about 3 months of income/);
  });

  test("months of income reads as one figure after the point", () => {
    // The money rounder over a number already scaled by ten said "1.064".
    const out = creditScore({
      record: perfect, utilisation: 0, owed: 53190, monthlyIncome: 50000, historyMonths: 12
    });
    const owed = out.parts.find((p) => p.label.startsWith("What you owe"));
    assert.match(owed.detail, /about 1\.1 months of income$/);
  });

  test("owing more than that does not go below zero", () => {
    const out = creditScore({
      record: perfect, utilisation: 0, owed: 5000000, monthlyIncome: 50000, historyMonths: 12
    });
    assert.ok(out.parts.every((p) => p.points >= 0));
    assert.ok(out.score >= 0);
  });

  test("it names the part with the most left on the table", () => {
    const out = creditScore({
      record: perfect, utilisation: 100, owed: 0, monthlyIncome: 50000, historyMonths: 12
    });
    assert.match(out.summary, /how much of the card you use/);
  });

  test("and says so plainly when there is nothing left to fix", () => {
    const out = creditScore({
      record: perfect, utilisation: 0, owed: 0, monthlyIncome: 50000, historyMonths: 12
    });
    assert.match(out.summary, /as good as it gets/);
  });

  test("the bands land where they say they do", () => {
    // Everything but the paying, done perfectly, is worth 50 of the 100 — so
    // missing every payment while owing nothing on an unused card still lands
    // at shaky rather than poor. Getting to poor takes doing badly at more
    // than one thing.
    const at = (onTime, due) => creditScore({
      record: { onTime, late: 0, missed: due - onTime, due },
      utilisation: 0, owed: 0, monthlyIncome: 50000, historyMonths: 12
    }).band;
    assert.equal(at(100, 100), "strong");
    assert.equal(at(20, 100), "fair");
    assert.equal(at(0, 100), "shaky");

    const everything = creditScore({
      record: { onTime: 0, late: 0, missed: 12, due: 12 },
      utilisation: 100, owed: 150000, monthlyIncome: 50000, historyMonths: 0
    });
    assert.equal(everything.score, 0);
    assert.equal(everything.band, "poor");
  });
});

describe("the report", () => {
  const card = {
    status: "active", product: "secured_card", opened_on: "2026-01-01",
    standing: { outstanding: 0 },
    card: {
      balance: 2000, utilisation: 20, interestCharged: 150, lateFeesCharged: 20,
      statements: [statement("2026-06-21", { missed: true })]
    }
  };

  test("adds up what is owed across both kinds of thing", () => {
    const out = creditReport({
      year: 2026, todayIso: TODAY, monthlyIncome: 50000,
      facilities: [
        card,
        { status: "active", product: "bnpl", opened_on: "2026-02-01", standing: { outstanding: 3000 }, installments: [] }
      ]
    });
    assert.equal(out.owedOnCards, 2000);
    assert.equal(out.owedOnPlans, 3000);
    assert.equal(out.owed, 5000);
  });

  test("a settled facility is not still owed", () => {
    const out = creditReport({
      year: 2026, todayIso: TODAY,
      facilities: [{ status: "settled", product: "bnpl", opened_on: "2026-02-01", standing: { outstanding: 0 }, installments: [] }]
    });
    assert.equal(out.owed, 0);
  });

  test("what borrowing cost is the fees, the interest and the late fees together", () => {
    const out = creditReport({
      year: 2026, todayIso: TODAY,
      facilities: [card],
      opened: [{ product: "day_loan", count: 2, principal: 20000, fee: 400 }]
    });
    assert.equal(out.fees, 400);
    assert.equal(out.interest, 150);
    assert.equal(out.lateFees, 20);
    assert.equal(out.costOfBorrowing, 570);
    assert.equal(out.borrowed, 20000);
  });

  test("the top category is the first of them", () => {
    const out = creditReport({
      year: 2026, todayIso: TODAY,
      categories: [
        { name: "Housing", icon: "🏠", total: 240000, count: 12 },
        { name: "Food & Dining", icon: "🍔", total: 90000, count: 140 }
      ]
    });
    assert.equal(out.topCategory.name, "Housing");
  });

  test("a year with nothing in it says so rather than showing zeroes", () => {
    const out = creditReport({ year: 2025, todayIso: TODAY });
    assert.equal(out.hasActivity, false);
    assert.equal(out.score.score, null);
  });
});
