// A year of credit, gathered up: what was borrowed, what is still owed, whether
// it was paid when it was meant to be, and what the money went on.
//
// The score here is this app's own, out of 100, worked out from this app's own
// records. It is deliberately not on the 300-850 scale a bureau uses, because it
// is not a bureau score: nobody outside has been asked, nobody outside is told,
// and it follows you nowhere. What it is good for is the same thing the rest of
// this module is good for — showing which of your own figures moved a number,
// and what would move it back.
//
// Pure. Rows in, plain object out.

import { monthsBetween, toISODate } from "./dates.js";

const round = (n) => Math.round(Number(n) * 100) / 100;
const inYear = (iso, year) => Boolean(iso) && toISODate(iso).slice(0, 4) === String(year);

// Every payment the year asked for, and whether it arrived. An instalment is on
// time if it was paid by its date; a statement counts only if it asked for
// something, since one that asked for nothing is met the moment it is drawn and
// would otherwise pad the record with payments nobody made.
export function paymentRecord(facilities, year, todayIso = toISODate(new Date())) {
  let onTime = 0;
  let late = 0;
  let missed = 0;

  for (const facility of facilities) {
    for (const installment of facility.installments || []) {
      if (!inYear(installment.due_on, year)) continue;
      if (installment.paid_on) {
        if (toISODate(installment.paid_on) <= toISODate(installment.due_on)) onTime += 1;
        else late += 1;
      } else if (toISODate(installment.due_on) < todayIso) {
        missed += 1;
      }
    }

    for (const statement of facility.card?.statements || []) {
      if (!inYear(statement.dueOn, year)) continue;
      if (statement.minimumDue <= 0) continue;
      if (statement.met) onTime += 1;
      else if (statement.missed) missed += 1;
    }
  }

  return { onTime, late, missed, due: onTime + late + missed };
}

// Each part of the score carries its own maximum, and only the parts that apply
// are counted — somebody with no card is not marked down for not having one.
// The total is then scaled to 100, so the number always means the same thing.
export function creditScore({ record, utilisation = null, owed = 0, monthlyIncome = 0, historyMonths = 0 }) {
  const parts = [];

  if (record.due > 0) {
    const kept = record.onTime / record.due;
    parts.push({
      label: "Paying on time",
      max: 50,
      points: Math.round(50 * kept),
      detail: `${record.onTime} of ${record.due} payments arrived on time` +
        (record.missed > 0 ? `, and ${record.missed} did not arrive at all` : "") +
        (record.late > 0 ? `, ${record.late} arrived late` : "")
    });
  }

  if (utilisation !== null) {
    const used = Math.min(Math.max(utilisation, 0), 100);
    parts.push({
      label: "How much of the card you use",
      max: 20,
      points: Math.round(20 * (1 - used / 100)),
      detail: `${used}% of the limit is in use` +
        (used > 50 ? " — under half of it counts for more here" : "")
    });
  }

  if (monthlyIncome > 0) {
    // Three months' income owed is where this part runs out.
    const months = owed / monthlyIncome;
    const share = Math.min(months / 3, 1);
    parts.push({
      label: "What you owe against what you earn",
      max: 20,
      points: Math.round(20 * (1 - share)),
      detail: owed > 0
        // One decimal place. round() here is the money rounder, and running it
        // over a figure already scaled by ten gave "about 1.064 months".
        ? `You owe about ${Math.round(months * 10) / 10} months of income`
        : "You owe nothing"
    });
  }

  if (historyMonths > 0) {
    const settled = Math.min(historyMonths / 12, 1);
    parts.push({
      label: "How long you have been at it",
      max: 10,
      points: Math.round(10 * settled),
      detail: `${historyMonths} month${historyMonths === 1 ? "" : "s"} of credit history here`
    });
  }

  const available = parts.reduce((sum, p) => sum + p.max, 0);
  if (available === 0) {
    return {
      score: null,
      band: "not enough history",
      parts: [],
      summary: "Nothing has been borrowed or repaid here yet, so there is nothing to score."
    };
  }

  const earned = parts.reduce((sum, p) => sum + p.points, 0);
  const score = Math.round((earned / available) * 100);
  const band = score >= 80 ? "strong" : score >= 60 ? "fair" : score >= 40 ? "shaky" : "poor";

  // The part with the most points left on the table is the one worth naming.
  const weakest = [...parts].sort(
    (a, b) => (b.max - b.points) - (a.max - a.points)
  )[0];
  const gap = weakest ? weakest.max - weakest.points : 0;

  return {
    score,
    band,
    parts,
    summary: gap > 0
      ? `${weakest.label.charAt(0).toLowerCase()}${weakest.label.slice(1)} is what is holding this back most.`
      : "Every part of this is as good as it gets."
  };
}

// The whole report. Everything it needs has already been read; this only puts
// it together.
export function creditReport({
  year,
  facilities = [],
  opened = [],
  categories = [],
  purchases = [],
  monthlyIncome = 0,
  todayIso = toISODate(new Date())
}) {
  const active = facilities.filter((f) => f.status === "active");

  const owedOnPlans = active.reduce((sum, f) => sum + (f.standing?.outstanding || 0), 0);
  const owedOnCards = active.reduce((sum, f) => sum + (f.card?.balance || 0), 0);
  const owed = round(owedOnPlans + owedOnCards);

  const card = active.find((f) => f.product === "secured_card") || null;
  const record = paymentRecord(facilities, year, todayIso);

  // How long there has been anything to go on, counted from the first thing
  // ever opened rather than from the start of the year being reported.
  const first = facilities
    .map((f) => toISODate(f.opened_on))
    .filter(Boolean)
    .sort()[0];
  const historyMonths = first ? Math.max(monthsBetween(first, todayIso).length - 1, 0) : 0;

  const score = creditScore({
    record,
    utilisation: card ? card.card.utilisation : null,
    owed,
    monthlyIncome,
    historyMonths
  });

  const borrowed = opened.reduce((sum, row) => sum + Number(row.principal || 0), 0);
  const charged = opened.reduce((sum, row) => sum + Number(row.fee || 0), 0);
  const interest = facilities.reduce((sum, f) => sum + (f.card?.interestCharged || 0), 0);
  const lateFees = facilities.reduce((sum, f) => sum + (f.card?.lateFeesCharged || 0), 0);

  return {
    year,
    owed,
    owedOnPlans: round(owedOnPlans),
    owedOnCards: round(owedOnCards),
    borrowed: round(borrowed),
    costOfBorrowing: round(charged + interest + lateFees),
    fees: round(charged),
    interest: round(interest),
    lateFees: round(lateFees),
    record,
    score,
    opened,
    topCategory: categories[0] || null,
    categories,
    purchases,
    hasActivity: facilities.length > 0 || purchases.length > 0
  };
}
