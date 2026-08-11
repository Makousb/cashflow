// Letting a lender see somebody's credit history, on that somebody's say-so.
//
// Two things decide the shape of this. The first is that consent is the whole
// mechanism: a check exists because the person made it, names the lender it was
// made for, runs out on a date they chose, and stops the moment they revoke it.
// Nothing here lets a bank go looking of its own accord, and there is no way to
// ask for somebody's history — only to be given it.
//
// The second is that a lender deciding on a mortgage needs to know whether debts
// get paid, not what the groceries cost. So what a check shows is the credit
// standing and nothing else: no wallet balances, no categories, no list of
// purchases, no email address. The spending that the owner sees on their own
// report is theirs, and handing over a history should not hand over a diary.
//
// Pure. Rows in, plain object out.

import { isCard } from "./cards.js";
import { monthsBetween, toISODate } from "./dates.js";
import { creditScore, paymentRecord } from "./credit-report.js";

export const PURPOSES = {
  mortgage: { label: "Mortgage", blurb: "Buying a home" },
  car_loan: { label: "Car loan", blurb: "Buying a vehicle" },
  business_loan: { label: "Business loan", blurb: "Funding a business" },
  other: { label: "Something else", blurb: "Any other borrowing" }
};

// How long a check may be left open. Long enough for a lender to work through
// an application, short enough that a link handed over once does not stay live
// for years afterwards.
export const MAX_DAYS = 90;
export const DEFAULT_DAYS = 30;

const round = (n) => Math.round(Number(n) * 100) / 100;

// Revoked beats expired: it is the more deliberate of the two, and the one the
// person will be looking for when they check that it worked.
export function checkStatus(check, todayIso = toISODate(new Date())) {
  if (check.revoked_at) return "revoked";
  if (toISODate(check.expires_on) < todayIso) return "expired";
  return "active";
}

export function isUsable(check, todayIso = toISODate(new Date())) {
  return checkStatus(check, todayIso) === "active";
}

// What the lender is handed. Built from the same facilities the owner's own
// report is built from, so the two cannot disagree — but carrying only the part
// a lending decision turns on.
export function sharedHistory({ facilities = [], monthlyIncome = 0, todayIso = toISODate(new Date()) }) {
  const active = facilities.filter((f) => f.status === "active");

  const owedOnPlans = active.reduce((sum, f) => sum + (f.standing?.outstanding || 0), 0);
  const owedOnCards = active.reduce((sum, f) => sum + (f.card?.balance || 0), 0);
  const owed = round(owedOnPlans + owedOnCards);

  // Across every card the person holds, not whichever one comes back first: two
  // cards half used is half used, and a lender shown one of them would be shown
  // a figure that depended on a sort order.
  const cards = active.filter((f) => isCard(f.product) && f.card);
  const cardLimit = cards.reduce((sum, f) => sum + f.card.limit, 0);
  const cardBalance = cards.reduce((sum, f) => sum + f.card.balance, 0);

  // Every year of it, not one — a lender is asking about a person's record, and
  // a single year can flatter or damn one.
  const record = paymentRecord(facilities, null, todayIso);

  const first = facilities.map((f) => toISODate(f.opened_on)).filter(Boolean).sort()[0];
  const historyMonths = first ? Math.max(monthsBetween(first, todayIso).length - 1, 0) : 0;

  const score = creditScore({
    record,
    utilisation: cardLimit > 0
      ? Math.min(Math.round((cardBalance / cardLimit) * 100), 100)
      : null,
    owed,
    monthlyIncome,
    historyMonths
  });

  // One line per facility: what it was, when it opened, where it stands, what is
  // left on it. No labels — somebody's name for a purchase is their business.
  const accounts = facilities.map((f) => ({
    product: f.product,
    openedOn: toISODate(f.opened_on),
    status: f.status,
    outstanding: round((f.standing?.outstanding || 0) + (f.card?.balance || 0)),
    limit: f.credit_limit == null ? null : Number(f.credit_limit)
  }));

  return {
    owed,
    owedOnPlans: round(owedOnPlans),
    owedOnCards: round(owedOnCards),
    record,
    score,
    historyMonths,
    accounts,
    openedCount: facilities.length,
    settledCount: facilities.filter((f) => f.status === "settled").length,
    // Named so the page can say plainly what is missing and why.
    withheld: [
      "what you spend and what on",
      "wallet and account balances",
      "individual purchases",
      "contact details"
    ]
  };
}
