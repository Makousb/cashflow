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

import { CARDS, eligibility, isCard, limitFor } from "./cards.js";
import { addDays, addMonths, monthKey, monthsBetween, toISODate } from "./dates.js";
import { LOAN_PAYMENT_NOTE } from "./loans.js";

// The catalogue everything else asks for a label. The cards come from
// utils/cards.js, which is where what a card is worth is decided; borrowing that
// is not a card is described here, because there is nowhere else it belongs.
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
  ...Object.fromEntries(
    Object.entries(CARDS).map(([product, card]) => [
      product,
      { label: card.label, blurb: card.blurb, terms: [], termNoun: "", card }
    ])
  )
};

export { isCard };

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

// The notes credit writes into the ledger, and the three sets of them the rest
// of the app has to recognise. Written from these and matched against these, so
// the entry the ledger carries and the entry a query ignores cannot drift.
export const DRAWDOWN_NOTE = "Day loan drawdown";
export const CREDIT_REPAYMENT_NOTE = "Credit repayment";
export const CARD_PAYMENT_NOTE = "Card payment";
export const DEPOSIT_NOTE = "Secured card deposit";
export const DEPOSIT_RETURNED_NOTE = `${DEPOSIT_NOTE} returned`;

// Money arriving that is not income. Borrowed money is real — it does arrive —
// but counting it as earnings lets borrowing raise the ceiling on borrowing, and
// a deposit coming back is the holder's own money returning.
export const NOT_EARNINGS = [`${DRAWDOWN_NOTE}%`, `${DEPOSIT_RETURNED_NOTE}%`];

// Money leaving that is not spending, for two different reasons.
//
// A repayment of something already counted as a commitment is not a second
// obligation beside it; it is that obligation being met, and counting both
// charged one promise twice against what was spare.
//
// A deposit is not spent at all. It is held against the limit and comes back
// when the card closes, so treating it as a month's spending made somebody look
// poorer for money they still owned — and since it returns as income, which is
// excluded above, counting it on the way out but not on the way back was
// lopsided into the bargain.
//
// A card payment is in neither list. Nothing counts it forward, so leaving it
// out would lose the outgoing rather than stop it being counted twice.
export const NOT_SPENDING = [
  `${LOAN_PAYMENT_NOTE}%`,
  `${CREDIT_REPAYMENT_NOTE}%`,
  `${DEPOSIT_NOTE}%`
];

// Money leaving that bought nothing, which is the above plus card payments —
// settling a card is paying for a purchase already counted where it was made.
export const NOT_A_PURCHASE = [...NOT_SPENDING, `${CARD_PAYMENT_NOTE}%`];

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

// A card above the secured one asks for no deposit, so what stands in for it is
// a record: what has been paid on time here, for how long, and against what
// income. Every gate is checked by utils/cards.js, which is also what the agent
// reads when it says how close somebody is — so the answer on this page and the
// answer the agent gave cannot disagree.
export function assessCard({ product, means, score, historyMonths, cleanMonths, record, held }) {
  const card = CARDS[product];
  if (!card) return declined("Unknown card.");

  const verdict = eligibility(product, {
    score,
    historyMonths,
    cleanMonths,
    record,
    held,
    monthlyIncome: means.income
  });
  if (!verdict.eligible) return declined(verdict.reason);

  const creditLimit = limitFor({
    product,
    monthlyIncome: means.income,
    cleanMonths
  });
  if (creditLimit <= 0) {
    return declined("There is not enough income recorded here to set a limit against.");
  }

  return {
    approved: true,
    reason: `${verdict.reason} Your limit is ${creditLimit.toFixed(2)} at ${card.apr}% APR.`,
    terms: {
      principal: 0,
      fee: 0,
      apr: card.apr,
      creditLimit,
      // Nothing is held against an unsecured card, which is the whole of the
      // difference between it and the one below it.
      deposit: null,
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
  if (isCard(product)) return assessCard({ ...input, product });
  return declined("Unknown product.");
}

const sumByMonth = (rows, dateField) => {
  const totals = new Map();
  for (const row of rows) {
    const key = monthKey(row[dateField]);
    totals.set(key, (totals.get(key) || 0) + Number(row.amount));
  }
  return totals;
};

// The statement cycle is the calendar month. A statement is drawn on the last
// day of it and has to be paid 21 days later.
const PAYMENT_DUE_DAYS = 21;
// The minimum is a twentieth of what is owed, or the interest that month if
// that is more. Never less than the interest, so paying the minimum always
// leaves the balance smaller than it was rather than standing still.
const MINIMUM_RATE = 0.05;
// How long before the date a reminder is worth having: long enough to move
// money, short enough that it is still about this month.
const REMINDER_DAYS = 3;
// Missing the minimum costs a tenth of what was short. A share rather than a
// flat sum, so it means the same thing in any currency, and so paying most of
// the minimum costs most of nothing — the fee is for the gap, not for being
// late as such.
const LATE_FEE_RATE = 0.1;

// The last day of a YYYY-MM: day zero of the month after it.
function lastDayOf(key) {
  const [year, month] = key.split("-").map(Number);
  return toISODate(new Date(year, month, 0));
}

// One walk over the months a card has been open, producing both what is owed
// now and the statement drawn at the end of each month that has finished.
//
// Interest is charged on what is carried past the end of a month, which is what
// the card says it does: spending inside a month and clearing it before the
// month is out costs nothing. So each month takes its charges, takes off its
// payments, and only then accrues on what is left — and the month in progress
// does not accrue at all, not having ended.
function walkCard(facility, charges, payments, todayIso) {
  const monthlyRate = Number(facility.apr || 0) / 100 / 12;
  const chargesBy = sumByMonth(charges, "charged_on");
  const paymentsBy = sumByMonth(payments, "paid_on");
  const thisMonth = monthKey(todayIso);

  let balance = 0;
  let interestCharged = 0;
  let lateFeesCharged = 0;
  const statements = [];

  for (const key of monthsBetween(facility.opened_on, todayIso)) {
    // A statement falls due in the month after the one it was drawn for, so the
    // month being walked is where the previous statement's date has just gone
    // by. If it went by unmet, the fee lands here — before the month's interest,
    // because that is when it was charged, and it earns interest like the rest.
    const fellDue = statements.at(-1);
    if (fellDue && fellDue.missed && monthKey(fellDue.dueOn) === key) {
      const fee = round(fellDue.shortfall * LATE_FEE_RATE);
      if (fee > 0) {
        balance = round(balance + fee);
        lateFeesCharged = round(lateFeesCharged + fee);
        fellDue.lateFee = fee;
      }
    }

    balance += chargesBy.get(key) || 0;
    balance -= paymentsBy.get(key) || 0;
    // Paying in more than is owed leaves a credit, not a debt earning interest.
    if (balance < 0) balance = 0;

    if (key < thisMonth) {
      const interest = round(balance * monthlyRate);
      balance = round(balance + interest);
      interestCharged = round(interestCharged + interest);

      const closedOn = lastDayOf(key);
      const dueOn = addDays(closedOn, PAYMENT_DUE_DAYS);
      const minimumDue = balance <= 0
        ? 0
        : round(Math.min(balance, Math.max(balance * MINIMUM_RATE, interest)));

      // What was put towards it: anything paid after the statement was drawn
      // and by the day it is due. Those payments also come off the balance in
      // the month they were made — one payment doing both jobs, which is what
      // paying a card is.
      const paidTowards = round(
        payments
          .filter((p) => {
            const on = toISODate(p.paid_on);
            return on > closedOn && on <= dueOn;
          })
          .reduce((sum, p) => sum + Number(p.amount), 0)
      );

      const met = paidTowards >= minimumDue;
      const missed = !met && dueOn < todayIso;
      const shortfall = round(Math.max(minimumDue - paidTowards, 0));
      // The day the reminder becomes worth sending. A statement asking for
      // nothing is met from the moment it is drawn, so it never gets here.
      const remindOn = addDays(dueOn, -REMINDER_DAYS);

      statements.push({
        cycle: key,
        closedOn,
        dueOn,
        remindOn,
        balance,
        interest,
        minimumDue,
        paidTowards,
        shortfall,
        // Filled in when the month its date falls in is walked; a statement
        // still inside its window has not been charged for anything yet.
        lateFee: 0,
        met,
        // Not yet due is not yet missed.
        missed,
        due: !met && dueOn >= todayIso,
        // Due, and close enough to the date to say so.
        dueSoon: !met && !missed && todayIso >= remindOn
      });
    }
  }

  return { balance, interestCharged, lateFeesCharged, statements };
}

// What a card owes and where its statements stand.
export function cardStanding(facility, charges = [], payments = [], todayIso = toISODate(new Date())) {
  const limit = Number(facility.credit_limit || 0);
  const monthlyRate = Number(facility.apr || 0) / 100 / 12;
  const { balance, interestCharged, lateFeesCharged, statements } = walkCard(
    facility, charges, payments, todayIso
  );

  const owed = round(balance);
  const latest = statements.length ? statements[statements.length - 1] : null;
  const missed = statements.filter((s) => s.missed);
  const spent = round(charges.reduce((sum, c) => sum + Number(c.amount), 0));
  const repaid = round(payments.reduce((sum, p) => sum + Number(p.amount), 0));

  return {
    limit,
    balance: owed,
    available: round(Math.max(limit - owed, 0)),
    // What this month will cost if the balance is still here when it ends.
    monthlyInterest: round(owed * monthlyRate),
    interestCharged: round(interestCharged),
    lateFeesCharged: round(lateFeesCharged),
    spent,
    repaid,
    utilisation: limit > 0 ? Math.min(Math.round((owed / limit) * 100), 100) : 0,
    statements,
    // The statement that is still asking for something, if one is: the most
    // recent one, unless it has already been met.
    statement: latest && !latest.met ? latest : null,
    // What has to be paid, and by when, to keep the card straight.
    minimumDue: latest && !latest.met ? latest.minimumDue : 0,
    dueOn: latest && !latest.met ? latest.dueOn : null,
    missedCount: missed.length,
    hasMissed: missed.length > 0
  };
}

// Which notice a card is owed, if any.
//
// A statement already past its date beats one merely approaching it: being late
// on June is the more useful thing to hear about, and nobody wants both emails
// in the same breath. Each is sent once per statement, which is what stops a
// reminder arriving every day of the three it is open for.
export function noticeDue(standing) {
  const missed = standing.statements.filter((s) => s.missed).at(-1);
  if (missed) return { kind: "missed", statement: missed };

  const soon = standing.statements.filter((s) => s.dueSoon).at(-1);
  if (soon) return { kind: "reminder", statement: soon };

  return null;
}

// A charge is refused for one reason only: there is not the room for it.
export function assessCharge({ amount, standing }) {
  const value = round(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return declined("Enter what the purchase cost.");
  }
  if (value > standing.available) {
    return declined(
      `That is more than the ${standing.available.toFixed(2)} left on the card. ` +
      `The limit is ${standing.limit.toFixed(2)} and ${standing.balance.toFixed(2)} of it is already used.`
    );
  }
  return { approved: true, reason: `Charged ${value.toFixed(2)}.`, terms: { amount: value } };
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
