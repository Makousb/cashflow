// Personal credit: what can be offered, on what terms, and — more usefully —
// why not.
//
// Every decision here is made from the applicant's own ledger: what comes in,
// what goes out, and what they already owe in this app. There is no bureau
// behind it and no lender; nothing here is an offer of credit by anybody. What
// it is, is arithmetic the applicant can check, which is why a decline carries
// the number that caused it rather than a shrug.
//
// Pure. Everything takes plain figures and returns plain objects, so the rules
// can be read and tested without a database anywhere near them.

import { addDays, addMonths, toISODate } from "./dates.js";

export const PRODUCTS = {
  day_loan: {
    label: "Day loan",
    blurb: "A small amount to bridge a few days, repaid in one go.",
    terms: [7, 14, 30],
    termNoun: "days"
  },
  bnpl: {
    label: "Pay in instalments",
    blurb: "Take the purchase now and spread it over equal monthly payments.",
    terms: [3, 4, 6],
    termNoun: "instalments"
  },
  secured_card: {
    label: "Secured card",
    blurb: "A card with a limit equal to a deposit you put up yourself.",
    terms: [],
    termNoun: ""
  }
};

// A day loan costs 1% of what is borrowed for every 7 days it is held.
const DAY_LOAN_FEE_PER_WEEK = 0.01;
// And is capped at half a month's income, whatever else the figures allow.
const DAY_LOAN_INCOME_SHARE = 0.5;
// A plan's monthly instalment may not take more than a quarter of what is
// spare, so that agreeing to one does not spend the room for everything else.
const BNPL_DISPOSABLE_SHARE = 0.25;
// Interest on a card balance carried past the month. The deposit secures the
// limit; it does not make the borrowing free.
const SECURED_CARD_APR = 30;

const round = (n) => Math.round(Number(n) * 100) / 100;

// Split a total into n parts that add back up to it exactly. Done in cents,
// with the rounding dust on the last instalment, because three instalments of
// 33.33 are not a hundred and the difference is somebody's money.
export function splitEvenly(total, parts) {
  const cents = Math.round(Number(total) * 100);
  const each = Math.floor(cents / parts);
  const dust = cents - each * parts;
  return Array.from({ length: parts }, (_, i) =>
    (each + (i === parts - 1 ? dust : 0)) / 100
  );
}

// What the ledger says there is room for. Commitments are what is already
// promised each month — existing loan minimums and live credit here — because
// affording a new payment means affording it alongside those.
export function affordability({ monthlyIncome = 0, monthlyExpenses = 0, monthlyCommitments = 0 } = {}) {
  const income = Math.max(round(monthlyIncome), 0);
  const expenses = Math.max(round(monthlyExpenses), 0);
  const commitments = Math.max(round(monthlyCommitments), 0);
  return {
    income,
    expenses,
    commitments,
    disposable: round(Math.max(income - expenses - commitments, 0))
  };
}

const declined = (reason) => ({ approved: false, reason, terms: null });

// One repayment, the whole thing, on the day the term runs out.
export function assessDayLoan({ amount, days, means, hasActiveDayLoan = false, from }) {
  const principal = round(amount);
  if (!Number.isFinite(principal) || principal <= 0) {
    return declined("Enter how much you need.");
  }
  if (!PRODUCTS.day_loan.terms.includes(Number(days))) {
    return declined("Choose one of the offered terms.");
  }
  if (hasActiveDayLoan) {
    return declined("You already have a day loan running. Settle it before taking another.");
  }
  if (means.income <= 0) {
    return declined(
      "There is no income recorded here yet, so there is nothing to lend against. " +
      "Record what you earn and try again."
    );
  }

  const cap = round(means.income * DAY_LOAN_INCOME_SHARE);
  if (principal > cap) {
    return declined(
      `A day loan is capped at half your monthly income, which is ${cap.toFixed(2)}.`
    );
  }

  const fee = round(principal * DAY_LOAN_FEE_PER_WEEK * (Number(days) / 7));
  const total = round(principal + fee);
  if (total > means.disposable) {
    return declined(
      `Repaying ${total.toFixed(2)} in one go needs more room than the ` +
      `${means.disposable.toFixed(2)} a month you have spare after what you already spend and owe.`
    );
  }

  const dueOn = addDays(from, Number(days));
  return {
    approved: true,
    reason: `Repay ${total.toFixed(2)} on ${dueOn}.`,
    terms: {
      principal,
      fee,
      apr: 0,
      total,
      dueOn,
      schedule: [{ sequence: 1, dueOn, amount: total }]
    }
  };
}

// The purchase happens now; the money leaves monthly, in equal parts, at no
// interest. Nothing is posted to the ledger until an instalment is actually
// paid, because until then no money has moved.
export function assessBnpl({ amount, installments, means, outstandingPlans = 0, from }) {
  const total = round(amount);
  const parts = Number(installments);
  if (!Number.isFinite(total) || total <= 0) {
    return declined("Enter what the purchase costs.");
  }
  if (!PRODUCTS.bnpl.terms.includes(parts)) {
    return declined("Choose one of the offered instalment counts.");
  }
  if (means.income <= 0) {
    return declined(
      "There is no income recorded here yet, so there is nothing to spread this against."
    );
  }

  const amounts = splitEvenly(total, parts);
  const perMonth = amounts[0];
  const room = round(means.disposable * BNPL_DISPOSABLE_SHARE);
  if (perMonth > room) {
    return declined(
      `${perMonth.toFixed(2)} a month is more than the ${room.toFixed(2)} a plan may take, ` +
      `which is a quarter of what you have spare. Fewer instalments will not help; a smaller purchase will.`
    );
  }

  const stacked = round(Number(outstandingPlans) + total);
  if (stacked > means.income) {
    return declined(
      `This would put ${stacked.toFixed(2)} on plans at once, which is more than a month's income. ` +
      "Clear some of what is running first."
    );
  }

  // addMonths hands back a Date where addDays hands back a string, so this is
  // put into the one shape everything downstream compares and stores.
  const schedule = amounts.map((value, i) => ({
    sequence: i + 1,
    dueOn: toISODate(addMonths(from, i + 1)),
    amount: value
  }));

  return {
    approved: true,
    reason: `${parts} monthly payments of ${perMonth.toFixed(2)}, interest free.`,
    terms: {
      principal: total,
      fee: 0,
      apr: 0,
      total,
      perMonth,
      dueOn: schedule[schedule.length - 1].dueOn,
      schedule
    }
  };
}

// The deposit is the limit. There is no minimum, because a small deposit simply
// buys a small card — and no assessment of income either, since the money
// backing it is already the applicant's own. What it does need is the deposit
// actually being there.
export function assessSecuredCard({ deposit, walletBalance = 0, hasActiveCard = false }) {
  const held = round(deposit);
  if (!Number.isFinite(held) || held <= 0) {
    return declined("Enter the deposit you want to put up.");
  }
  if (hasActiveCard) {
    return declined("You already hold a secured card. Close it to open another.");
  }
  if (held > round(walletBalance)) {
    return declined(
      `The wallet you chose holds ${round(walletBalance).toFixed(2)}, which will not cover a ` +
      `${held.toFixed(2)} deposit.`
    );
  }

  return {
    approved: true,
    reason: `Deposit ${held.toFixed(2)} and the limit is the same.`,
    terms: {
      principal: 0,
      fee: 0,
      apr: SECURED_CARD_APR,
      creditLimit: held,
      deposit: held,
      total: 0,
      dueOn: null,
      schedule: []
    }
  };
}

// One way in, so the controller does not grow a branch per product.
export function assess(product, input) {
  if (product === "day_loan") return assessDayLoan(input);
  if (product === "bnpl") return assessBnpl(input);
  if (product === "secured_card") return assessSecuredCard(input);
  return declined("Unknown product.");
}

// What a facility still owes, and where it stands. Instalments are the truth
// for the two that have them; a card owes its balance and holds its deposit.
export function facilityStanding(facility, installments = [], todayIso = toISODate(new Date())) {
  const rows = [...installments].sort((a, b) => a.sequence - b.sequence);
  const outstanding = rows
    .filter((r) => !r.paid_on)
    .reduce((sum, r) => sum + Number(r.amount), 0);
  const paid = rows
    .filter((r) => r.paid_on)
    .reduce((sum, r) => sum + Number(r.amount), 0);
  const next = rows.find((r) => !r.paid_on) || null;
  const overdue = rows.filter((r) => !r.paid_on && r.due_on && toISODate(r.due_on) < todayIso);

  return {
    outstanding: round(outstanding),
    paid: round(paid),
    next,
    overdueCount: overdue.length,
    isOverdue: overdue.length > 0,
    settled: rows.length > 0 && outstanding === 0,
    creditLimit: facility.credit_limit == null ? null : Number(facility.credit_limit),
    deposit: facility.deposit == null ? null : Number(facility.deposit)
  };
}
