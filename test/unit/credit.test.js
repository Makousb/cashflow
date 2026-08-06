import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  affordability,
  assess,
  assessBnpl,
  assessDayLoan,
  assessSecuredCard,
  facilityStanding,
  splitEvenly
} from "../../utils/credit.js";

// Someone with room: 100k in, 60k out, 10k already promised — 30k spare.
const comfortable = affordability({
  monthlyIncome: 100000, monthlyExpenses: 60000, monthlyCommitments: 10000
});
const FROM = "2026-08-05";

describe("splitEvenly", () => {
  test("the parts add back up to the whole", () => {
    // Three ways of 100 is not 33.33 three times, and the missing cent is
    // somebody's money.
    const parts = splitEvenly(100, 3);
    assert.equal(parts.reduce((a, b) => a + b, 0), 100);
    assert.deepEqual(parts, [33.33, 33.33, 33.34]);
  });

  test("an amount that divides cleanly is left alone", () => {
    assert.deepEqual(splitEvenly(120, 4), [30, 30, 30, 30]);
  });

  test("the dust lands on the last part, never the first", () => {
    const parts = splitEvenly(10, 6);
    assert.equal(parts[0], 1.66);
    assert.equal(parts.at(-1), 1.7);
    assert.equal(Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100, 10);
  });
});

describe("affordability", () => {
  test("what is spare is what is left after spending and promises", () => {
    assert.equal(comfortable.disposable, 30000);
  });

  test("it does not go below zero", () => {
    const stretched = affordability({ monthlyIncome: 1000, monthlyExpenses: 4000 });
    assert.equal(stretched.disposable, 0);
  });
});

describe("a day loan", () => {
  test("is approved with the fee and the day it falls due", () => {
    const out = assessDayLoan({ amount: 10000, days: 14, means: comfortable, from: FROM });
    assert.equal(out.approved, true);
    // 1% a week, so a fortnight is 2%.
    assert.equal(out.terms.fee, 200);
    assert.equal(out.terms.total, 10200);
    assert.equal(out.terms.dueOn, "2026-08-19");
  });

  test("is repaid in one go, on that day", () => {
    const out = assessDayLoan({ amount: 10000, days: 7, means: comfortable, from: FROM });
    assert.equal(out.terms.schedule.length, 1);
    assert.deepEqual(out.terms.schedule[0], {
      sequence: 1, dueOn: "2026-08-12", amount: 10100
    });
  });

  test("is capped at half a month's income", () => {
    const out = assessDayLoan({ amount: 60000, days: 7, means: comfortable, from: FROM });
    assert.equal(out.approved, false);
    assert.match(out.reason, /capped at half your monthly income/);
    assert.match(out.reason, /50000\.00/);
  });

  test("is refused when repaying it would not fit in what is spare", () => {
    // Inside the income cap, but there is only 5,000 of room a month.
    const tight = affordability({ monthlyIncome: 100000, monthlyExpenses: 95000 });
    const out = assessDayLoan({ amount: 40000, days: 7, means: tight, from: FROM });
    assert.equal(out.approved, false);
    assert.match(out.reason, /needs more room than the 5000\.00/);
  });

  test("is refused while another is still running", () => {
    const out = assessDayLoan({
      amount: 1000, days: 7, means: comfortable, from: FROM, hasActiveDayLoan: true
    });
    assert.equal(out.approved, false);
    assert.match(out.reason, /already have a day loan/);
  });

  test("is refused when nothing has ever come in", () => {
    const nothing = affordability({ monthlyIncome: 0, monthlyExpenses: 0 });
    const out = assessDayLoan({ amount: 100, days: 7, means: nothing, from: FROM });
    assert.equal(out.approved, false);
    assert.match(out.reason, /no income recorded/);
  });

  test("only the offered terms are on offer", () => {
    const out = assessDayLoan({ amount: 1000, days: 21, means: comfortable, from: FROM });
    assert.equal(out.approved, false);
    assert.match(out.reason, /offered terms/);
  });
});

describe("a purchase plan", () => {
  test("is split into equal monthly payments at no interest", () => {
    const out = assessBnpl({ amount: 12000, installments: 4, means: comfortable, from: FROM });
    assert.equal(out.approved, true);
    assert.equal(out.terms.fee, 0);
    assert.equal(out.terms.apr, 0);
    assert.equal(out.terms.perMonth, 3000);
    assert.equal(out.terms.schedule.length, 4);
  });

  test("the first payment is a month out, not today", () => {
    const out = assessBnpl({ amount: 12000, installments: 3, means: comfortable, from: FROM });
    assert.deepEqual(
      out.terms.schedule.map((s) => s.dueOn),
      ["2026-09-05", "2026-10-05", "2026-11-05"]
    );
  });

  test("a plan started on the 31st does not skip a short month", () => {
    // The clamping addMonths does, seen from the outside: Jan 31 + 1 is the
    // 28th, not the 3rd of March.
    const out = assessBnpl({
      amount: 12000, installments: 3, means: comfortable, from: "2026-01-31"
    });
    assert.deepEqual(
      out.terms.schedule.map((s) => s.dueOn),
      ["2026-02-28", "2026-03-31", "2026-04-30"]
    );
  });

  test("the instalments add up to the purchase exactly", () => {
    const out = assessBnpl({ amount: 100, installments: 3, means: comfortable, from: FROM });
    const total = out.terms.schedule.reduce((sum, s) => sum + s.amount, 0);
    assert.equal(Math.round(total * 100) / 100, 100);
  });

  test("is refused when a payment would take more than a quarter of what is spare", () => {
    // 30,000 spare allows 7,500 a month; 40,000 over 3 is more than that.
    const out = assessBnpl({ amount: 40000, installments: 3, means: comfortable, from: FROM });
    assert.equal(out.approved, false);
    assert.match(out.reason, /more than the 7500\.00 a plan may take/);
  });

  test("is refused when plans would stack past a month's income", () => {
    const out = assessBnpl({
      amount: 20000, installments: 6, means: comfortable, from: FROM,
      outstandingPlans: 90000
    });
    assert.equal(out.approved, false);
    assert.match(out.reason, /more than a month's income/);
  });
});

describe("a secured card", () => {
  test("has a limit equal to the deposit", () => {
    const out = assessSecuredCard({ deposit: 15000, walletBalance: 20000 });
    assert.equal(out.approved, true);
    assert.equal(out.terms.creditLimit, 15000);
    assert.equal(out.terms.deposit, 15000);
  });

  test("charges nothing to open and owes nothing on day one", () => {
    const out = assessSecuredCard({ deposit: 15000, walletBalance: 20000 });
    assert.equal(out.terms.fee, 0);
    assert.equal(out.terms.principal, 0);
    assert.equal(out.terms.schedule.length, 0);
  });

  test("is refused when the wallet cannot cover the deposit", () => {
    const out = assessSecuredCard({ deposit: 15000, walletBalance: 900 });
    assert.equal(out.approved, false);
    assert.match(out.reason, /holds 900\.00/);
  });

  test("is refused when one is already held", () => {
    const out = assessSecuredCard({ deposit: 100, walletBalance: 5000, hasActiveCard: true });
    assert.equal(out.approved, false);
    assert.match(out.reason, /already hold a secured card/);
  });

  test("asks nothing of income, the money being the applicant's own", () => {
    const out = assessSecuredCard({ deposit: 500, walletBalance: 500 });
    assert.equal(out.approved, true);
  });
});

describe("assess", () => {
  test("routes to the product asked for", () => {
    const out = assess("day_loan", { amount: 5000, days: 7, means: comfortable, from: FROM });
    assert.equal(out.approved, true);
  });

  test("refuses a product it does not have", () => {
    assert.equal(assess("mortgage", {}).approved, false);
  });
});

describe("where a facility stands", () => {
  const facility = { credit_limit: null, deposit: null };
  const rows = [
    { sequence: 1, amount: "100", due_on: "2026-07-01", paid_on: "2026-07-01" },
    { sequence: 2, amount: "100", due_on: "2026-08-01", paid_on: null },
    { sequence: 3, amount: "100", due_on: "2026-09-01", paid_on: null }
  ];

  test("counts what is left and what has gone", () => {
    const standing = facilityStanding(facility, rows, "2026-08-05");
    assert.equal(standing.outstanding, 200);
    assert.equal(standing.paid, 100);
  });

  test("the next one due is the earliest unpaid", () => {
    assert.equal(facilityStanding(facility, rows, "2026-08-05").next.sequence, 2);
  });

  test("an instalment past its date is overdue", () => {
    const standing = facilityStanding(facility, rows, "2026-08-05");
    assert.equal(standing.isOverdue, true);
    assert.equal(standing.overdueCount, 1);
  });

  test("and is not, the day before", () => {
    assert.equal(facilityStanding(facility, rows, "2026-07-31").isOverdue, false);
  });

  test("everything paid is settled", () => {
    const done = rows.map((r) => ({ ...r, paid_on: "2026-09-01" }));
    const standing = facilityStanding(facility, done, "2026-09-02");
    assert.equal(standing.settled, true);
    assert.equal(standing.outstanding, 0);
  });

  test("a card has no instalments and so settles nothing", () => {
    const card = facilityStanding({ credit_limit: "5000", deposit: "5000" }, [], "2026-08-05");
    assert.equal(card.settled, false);
    assert.equal(card.outstanding, 0);
    assert.equal(card.creditLimit, 5000);
  });
});
