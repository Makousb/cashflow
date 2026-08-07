import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  affordability,
  assess,
  assessBnpl,
  assessCharge,
  assessDayLoan,
  assessSecuredCard,
  cardStanding,
  facilityStanding,
  noticeDue,
  splitEvenly
} from "../../utils/credit.js";

// Someone with room: 100k in, 60k out, 10k already promised — 30k spare.
const comfortable = affordability({
  monthlyIncome: 100000, monthlyExpenses: 60000, monthlyCommitments: 10000
});
const FROM = "2026-08-05";
const round2 = (n) => Math.round(n * 100) / 100;

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

describe("a card in use", () => {
  // Opened in June, 10,000 limit, 24% a year — 2% a month.
  const card = { credit_limit: 10000, apr: 24, opened_on: "2026-06-01" };
  const charge = (amount, charged_on) => ({ amount, charged_on });
  const payment = (amount, paid_on) => ({ amount, paid_on });

  test("spending uses the limit up and the rest stays available", () => {
    const out = cardStanding(card, [charge(2500, "2026-08-02")], [], "2026-08-05");
    assert.equal(out.balance, 2500);
    assert.equal(out.available, 7500);
    assert.equal(out.utilisation, 25);
  });

  test("cleared inside the month, it costs nothing", () => {
    const out = cardStanding(
      card, [charge(2000, "2026-08-02")], [payment(2000, "2026-08-04")], "2026-08-05"
    );
    assert.equal(out.balance, 0);
    assert.equal(out.interestCharged, 0);
    assert.equal(out.available, 10000);
  });

  test("carried past the month, it does not", () => {
    // 1,000 left at the end of July, so August opens owing 1,000 plus 2%.
    const out = cardStanding(card, [charge(1000, "2026-07-10")], [], "2026-08-05");
    assert.equal(out.interestCharged, 20);
    assert.equal(out.balance, 1020);
  });

  test("interest compounds over the months it is carried", () => {
    // June and July both close owing, so 2% is charged twice — and June's
    // minimum going unmet puts a fee in between, which the second month's
    // interest is then charged on. 1,000 → 1,020 → +5.10 fee → 1,025.10 → 1,045.60.
    const out = cardStanding(card, [charge(1000, "2026-06-10")], [], "2026-08-05");
    assert.equal(out.interestCharged, 40.5);
    assert.equal(out.lateFeesCharged, 5.1);
    assert.equal(out.balance, 1045.6);
  });

  test("nothing is charged for a month whose minimum was met", () => {
    // The same two months, with June's 51 paid inside its window. No fee, and
    // the compounding is the whole of what happened.
    const out = cardStanding(
      card, [charge(1000, "2026-06-10")], [payment(51, "2026-07-10")], "2026-08-05"
    );
    assert.equal(out.lateFeesCharged, 0);
    // 1,020 less the 51 paid is 969, and 2% of that is 19.38.
    assert.equal(out.balance, round2(969 * 1.02));
  });

  test("the month in progress has not ended, so it has not been charged for", () => {
    const out = cardStanding(card, [charge(1000, "2026-08-01")], [], "2026-08-31");
    assert.equal(out.interestCharged, 0);
    // What it will cost if it is still there when the month turns.
    assert.equal(out.monthlyInterest, 20);
  });

  test("interest eats into what is left to spend", () => {
    const out = cardStanding(card, [charge(5000, "2026-07-10")], [], "2026-08-05");
    assert.equal(out.balance, 5100);
    assert.equal(out.available, 4900);
  });

  test("paying in more than is owed leaves no debt earning interest", () => {
    const out = cardStanding(
      card, [charge(500, "2026-06-10")], [payment(900, "2026-06-20")], "2026-08-05"
    );
    assert.equal(out.balance, 0);
    assert.equal(out.interestCharged, 0);
  });

  test("what was spent and what was repaid are both kept", () => {
    const out = cardStanding(
      card, [charge(300, "2026-08-01"), charge(200, "2026-08-02")],
      [payment(100, "2026-08-03")], "2026-08-05"
    );
    assert.equal(out.spent, 500);
    assert.equal(out.repaid, 100);
    assert.equal(out.balance, 400);
  });

  test("a card never used owes nothing and offers the lot", () => {
    const out = cardStanding(card, [], [], "2026-08-05");
    assert.equal(out.balance, 0);
    assert.equal(out.available, 10000);
    assert.equal(out.utilisation, 0);
  });
});

describe("a card's statement cycle", () => {
  // 2% a month, opened at the start of June.
  const card = { credit_limit: 10000, apr: 24, opened_on: "2026-06-01" };
  const charge = (amount, charged_on) => ({ amount, charged_on });
  const payment = (amount, paid_on) => ({ amount, paid_on });

  test("nothing is drawn until a month has finished", () => {
    const out = cardStanding(card, [charge(1000, "2026-06-10")], [], "2026-06-20");
    assert.equal(out.statements.length, 0);
    assert.equal(out.minimumDue, 0);
    assert.equal(out.statement, null);
  });

  test("a statement closes on the last of the month and falls due 21 days later", () => {
    const out = cardStanding(card, [charge(1000, "2026-06-10")], [], "2026-07-05");
    assert.equal(out.statements.length, 1);
    assert.equal(out.statements[0].closedOn, "2026-06-30");
    assert.equal(out.statements[0].dueOn, "2026-07-21");
  });

  test("it asks for a twentieth of what is owed", () => {
    const out = cardStanding(card, [charge(1000, "2026-06-10")], [], "2026-07-05");
    // 1,000 plus 2% is 1,020; a twentieth of that is 51.
    assert.equal(out.statements[0].balance, 1020);
    assert.equal(out.statements[0].minimumDue, 51);
    assert.equal(out.minimumDue, 51);
    assert.equal(out.dueOn, "2026-07-21");
  });

  test("and never less than the interest, so paying it always gains ground", () => {
    // At 120% a year the month's interest is more than a twentieth of the
    // balance, and a minimum under it would leave the debt growing.
    const dear = { ...card, apr: 120 };
    const out = cardStanding(dear, [charge(100, "2026-06-10")], [], "2026-07-05");
    assert.equal(out.statements[0].interest, 10);
    assert.equal(out.statements[0].minimumDue, 10);
    assert.ok(out.statements[0].minimumDue >= out.statements[0].interest);
  });

  test("paying it by the due date meets it", () => {
    const out = cardStanding(
      card, [charge(1000, "2026-06-10")], [payment(51, "2026-07-15")], "2026-07-20"
    );
    assert.equal(out.statements[0].met, true);
    assert.equal(out.statements[0].missed, false);
    assert.equal(out.statement, null, "a met statement is not still asking");
    assert.equal(out.minimumDue, 0);
  });

  test("paying it late does not", () => {
    const out = cardStanding(
      card, [charge(1000, "2026-06-10")], [payment(51, "2026-07-22")], "2026-07-25"
    );
    assert.equal(out.statements[0].met, false);
    assert.equal(out.statements[0].missed, true);
    assert.equal(out.hasMissed, true);
  });

  test("not yet due is not yet missed", () => {
    const out = cardStanding(card, [charge(1000, "2026-06-10")], [], "2026-07-05");
    assert.equal(out.statements[0].missed, false);
    assert.equal(out.statements[0].due, true);
    assert.equal(out.hasMissed, false);
  });

  test("a month that closes owing nothing asks for nothing", () => {
    const out = cardStanding(
      card, [charge(1000, "2026-06-10")], [payment(1000, "2026-06-20")], "2026-07-05"
    );
    assert.equal(out.statements[0].balance, 0);
    assert.equal(out.statements[0].minimumDue, 0);
    assert.equal(out.statements[0].met, true);
  });

  test("each month left unpaid is counted", () => {
    const out = cardStanding(card, [charge(1000, "2026-06-10")], [], "2026-08-25");
    // June and July both drawn, both past their date, both unpaid.
    assert.equal(out.statements.length, 2);
    assert.equal(out.missedCount, 2);
    assert.equal(out.statements.at(-1).cycle, "2026-07");
  });

  test("the one still asking is the latest, not the first missed", () => {
    const out = cardStanding(card, [charge(1000, "2026-06-10")], [], "2026-08-05");
    assert.equal(out.statement.cycle, "2026-07");
    // A twentieth of 1,045.60 — the balance including June's fee.
    assert.equal(out.minimumDue, 52.28);
    assert.equal(out.dueOn, "2026-08-21");
  });

  test("a payment counts towards the statement it lands in the window of", () => {
    // Paid in July, after June's statement was drawn and before it fell due.
    const out = cardStanding(
      card, [charge(1000, "2026-06-10")], [payment(60, "2026-07-10")], "2026-07-20"
    );
    assert.equal(out.statements[0].paidTowards, 60);
    assert.equal(out.statements[0].met, true);
    // And it came off the balance as well, which is the same payment doing both.
    assert.equal(out.balance, 960);
  });
});

describe("the fee for missing a minimum", () => {
  const card = { credit_limit: 10000, apr: 24, opened_on: "2026-06-01" };
  const charge = (amount, charged_on) => ({ amount, charged_on });
  const payment = (amount, paid_on) => ({ amount, paid_on });
  const june = [charge(1000, "2026-06-10")];

  test("is not charged while the date is still ahead", () => {
    const out = cardStanding(card, june, [], "2026-07-20");
    assert.equal(out.lateFeesCharged, 0);
    assert.equal(out.statements[0].lateFee, 0);
  });

  test("lands in the month the date fell in, once it has gone by", () => {
    const out = cardStanding(card, june, [], "2026-08-05");
    // A tenth of the 51 that was short.
    assert.equal(out.statements[0].lateFee, 5.1);
    assert.equal(out.lateFeesCharged, 5.1);
  });

  test("is a tenth of the gap, not of the whole minimum", () => {
    // 41 of the 51 paid, so 10 short, so a fee of 1.
    const out = cardStanding(card, june, [payment(41, "2026-07-10")], "2026-08-05");
    assert.equal(out.statements[0].shortfall, 10);
    assert.equal(out.statements[0].lateFee, 1);
  });

  test("paying all but a penny of it costs almost nothing", () => {
    // The point of charging the gap: being nearly right is nearly free.
    const out = cardStanding(card, june, [payment(50.99, "2026-07-10")], "2026-08-05");
    assert.equal(out.statements[0].shortfall, 0.01);
    assert.equal(out.statements[0].lateFee, 0);
  });

  test("is charged once, not again every month it stays unpaid", () => {
    const out = cardStanding(card, june, [], "2026-09-05");
    // June and July both missed by September, so two fees — one each, not one
    // for June repeated.
    const fees = out.statements.map((s) => s.lateFee);
    assert.equal(fees.length, 3);
    assert.equal(fees.filter((f) => f > 0).length, 2);
    assert.equal(round2(fees.reduce((a, b) => a + b, 0)), out.lateFeesCharged);
  });

  test("a statement asking for nothing cannot be missed, so costs nothing", () => {
    const out = cardStanding(
      card, june, [payment(1000, "2026-06-20")], "2026-08-05"
    );
    assert.equal(out.statements[0].minimumDue, 0);
    assert.equal(out.lateFeesCharged, 0);
    assert.equal(out.balance, 0);
  });
});

describe("which notice a card is owed", () => {
  const card = { credit_limit: 10000, apr: 24, opened_on: "2026-06-01" };
  const charge = (amount, charged_on) => ({ amount, charged_on });
  const payment = (amount, paid_on) => ({ amount, paid_on });
  // June's statement is drawn 2026-06-30 and due 2026-07-21, so the reminder
  // window opens on the 18th.
  const june = [charge(1000, "2026-06-10")];

  test("nothing, while the date is still a way off", () => {
    const out = cardStanding(card, june, [], "2026-07-17");
    assert.equal(out.statements[0].dueSoon, false);
    assert.equal(noticeDue(out), null);
  });

  test("a reminder, once it is close", () => {
    const out = cardStanding(card, june, [], "2026-07-18");
    assert.equal(out.statements[0].remindOn, "2026-07-18");
    assert.equal(out.statements[0].dueSoon, true);
    assert.equal(noticeDue(out).kind, "reminder");
    assert.equal(noticeDue(out).statement.cycle, "2026-06");
  });

  test("still a reminder on the day itself", () => {
    const out = cardStanding(card, june, [], "2026-07-21");
    assert.equal(noticeDue(out).kind, "reminder");
  });

  test("and the missed notice the day after", () => {
    const out = cardStanding(card, june, [], "2026-07-22");
    assert.equal(out.statements[0].dueSoon, false);
    assert.equal(noticeDue(out).kind, "missed");
  });

  test("nothing at all once the minimum is met", () => {
    const out = cardStanding(card, june, [payment(51, "2026-07-19")], "2026-07-20");
    assert.equal(out.statements[0].met, true);
    assert.equal(noticeDue(out), null);
  });

  test("a statement asking for nothing never asks for anything", () => {
    // Cleared inside the month, so the minimum is zero and met on sight.
    const out = cardStanding(
      card, june, [payment(1000, "2026-06-20")], "2026-07-19"
    );
    assert.equal(out.statements[0].minimumDue, 0);
    assert.equal(noticeDue(out), null);
  });

  test("being late beats being nearly due", () => {
    // June went unpaid and July is now approaching its own date. The late one
    // is the more useful thing to hear about, and only one email goes.
    const out = cardStanding(card, june, [], "2026-08-18");
    assert.equal(out.statements.length, 2);
    assert.equal(noticeDue(out).kind, "missed");
  });
});

describe("charging a card", () => {
  const standing = { limit: 10000, balance: 4000, available: 6000 };

  test("goes through when there is room", () => {
    const out = assessCharge({ amount: 6000, standing });
    assert.equal(out.approved, true);
    assert.equal(out.terms.amount, 6000);
  });

  test("is declined over the limit, and says by how much there is", () => {
    const out = assessCharge({ amount: 6000.01, standing });
    assert.equal(out.approved, false);
    assert.match(out.reason, /more than the 6000\.00 left/);
    assert.match(out.reason, /4000\.00 of it is already used/);
  });

  test("refuses nothing and less than nothing", () => {
    assert.equal(assessCharge({ amount: 0, standing }).approved, false);
    assert.equal(assessCharge({ amount: -5, standing }).approved, false);
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
