import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { loanMetrics, projectPayoff } from "../../utils/loans.js";

const loan = (over = {}) => ({
  principal: 100000, apr: 12, start_date: "2026-01-01", ...over
});

describe("loanMetrics", () => {
  test("an interest-free loan just sits there", () => {
    const metrics = loanMetrics(loan({ apr: 0 }), [], "2026-06-01");
    assert.equal(metrics.balance, 100000);
    assert.equal(metrics.interestAccrued, 0);
  });

  test("interest compounds monthly on the running balance", () => {
    // 1% a month for the three months Jan-Mar inclusive.
    const metrics = loanMetrics(loan(), [], "2026-03-01");
    assert.ok(Math.abs(metrics.balance - 100000 * 1.01 ** 3) < 0.01);
    assert.ok(metrics.interestAccrued > 0);
  });

  test("payments come off the balance", () => {
    const withPayment = loanMetrics(
      loan(), [{ amount: 20000, paid_on: "2026-02-10" }], "2026-03-01"
    );
    const without = loanMetrics(loan(), [], "2026-03-01");
    assert.ok(withPayment.balance < without.balance);
    assert.equal(withPayment.totalPaid, 20000);
  });

  test("interest still accrues in the month a payment lands", () => {
    const metrics = loanMetrics(
      loan(), [{ amount: 20000, paid_on: "2026-02-10" }], "2026-02-01"
    );
    assert.ok(metrics.interestAccrued > 0);
  });

  test("overpaying settles the loan rather than going negative", () => {
    const metrics = loanMetrics(
      loan(), [{ amount: 500000, paid_on: "2026-02-10" }], "2026-06-01"
    );
    assert.equal(metrics.balance, 0);
    assert.equal(metrics.isPaidOff, true);
    assert.equal(metrics.progressPct, 100);
  });

  test("progress is what has been paid against what it will take", () => {
    const metrics = loanMetrics(
      loan({ apr: 0 }), [{ amount: 25000, paid_on: "2026-02-10" }], "2026-03-01"
    );
    assert.equal(metrics.progressPct, 25);
  });

  test("several payments in one month all count", () => {
    const metrics = loanMetrics(loan({ apr: 0 }), [
      { amount: 10000, paid_on: "2026-02-05" },
      { amount: 15000, paid_on: "2026-02-20" }
    ], "2026-03-01");
    assert.equal(metrics.totalPaid, 25000);
    assert.equal(metrics.balance, 75000);
  });

  test("a loan starting today has not accrued anything much", () => {
    const metrics = loanMetrics(loan({ start_date: "2026-01-01" }), [], "2026-01-01");
    assert.ok(metrics.interestAccrued > 0, "the opening month still accrues");
    assert.ok(metrics.interestAccrued < 1100);
  });
});

describe("projectPayoff", () => {
  test("a settled loan is already done", () => {
    const plan = projectPayoff(0, 12, 5000, "2026-01-01");
    assert.equal(plan.months, 0);
    assert.equal(plan.neverPaysOff, false);
  });

  test("paying less than the interest never clears it", () => {
    // 100000 at 12% accrues 1000 a month; paying 900 goes backwards.
    const plan = projectPayoff(100000, 12, 900, "2026-01-01");
    assert.equal(plan.neverPaysOff, true);
    assert.equal(plan.months, null);
  });

  test("paying exactly the interest never clears it either", () => {
    assert.equal(projectPayoff(100000, 12, 1000, "2026-01-01").neverPaysOff, true);
  });

  test("an interest-free loan clears in the obvious number of months", () => {
    const plan = projectPayoff(10000, 0, 2500, "2026-01-01");
    assert.equal(plan.months, 4);
    assert.equal(plan.totalInterest, 0);
  });

  test("paying more clears it sooner and costs less interest", () => {
    const slow = projectPayoff(100000, 12, 5000, "2026-01-01");
    const fast = projectPayoff(100000, 12, 15000, "2026-01-01");
    assert.ok(fast.months < slow.months);
    assert.ok(fast.totalInterest < slow.totalInterest);
  });

  test("reports the date it comes off the books", () => {
    // Mid-month deliberately. Starting on the 1st is the one date this cannot
    // check: reading it as UTC midnight moves the start to the 31st, and adding
    // months to a 31st overflows back onto the 1st again, so a wrong answer and
    // the right one agree. On the 15th they do not.
    const plan = projectPayoff(10000, 0, 2500, "2026-01-15");
    assert.equal(plan.payoffDate, "2026-05-15");
  });

  test("clearing it from a 31st lands on the last day of a shorter month", () => {
    // One month on from Jan 31 is Feb 28, not March 3. Adding a month to a
    // 31st asks for a date that does not exist, and Date answers by running
    // past the end of the month rather than stopping at it.
    const plan = projectPayoff(10000, 0, 10000, "2026-01-31");
    assert.equal(plan.months, 1);
    assert.equal(plan.payoffDate, "2026-02-28");
  });

  test("and on the 29th in a leap year", () => {
    const plan = projectPayoff(10000, 0, 10000, "2024-01-31");
    assert.equal(plan.payoffDate, "2024-02-29");
  });
});
