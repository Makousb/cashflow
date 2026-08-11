// The card agent's judgement, as code.
//
// Everything here is a pure function over the holder's own rows. That division
// is the same one the accounting agent keeps and it matters for the same reason:
// a language model writes the covering note for these moves, and never a figure
// in one. "Pay 4,312.80 by the 21st" has to be reproducible from the statement
// it came from, and a model cannot promise that. The model explains what this
// file computes — nothing more.
//
// A move is something the holder could do today, with the number that makes it
// worth doing attached. Some carry an action the page turns into a button; the
// rest are things only a person can decide. Nothing here does anything: acting
// is the controller's job, and only ever within the standing instructions the
// holder set.

import { CARDS, isCard, limitIncrease, pointsMissed, pointsStanding, upgradePath } from "./cards.js";
import { creditScore, paymentRecord } from "./credit-report.js";
import { monthKey, monthsBetween, toISODate } from "./dates.js";

const round = (n) => Math.round(Number(n) * 100) / 100;

// A card at or above this much of its limit is close enough to maxed out that
// the number is the headline, whatever the holder's own target says.
const NEARLY_MAXED = 90;
// Spending has to be up by this much on last month, and be more than a rounding
// error, before it is a change rather than noise.
const PACE_RISE = 0.25;
// One category has to be this much of the month's card spending before singling
// it out says anything the total did not.
const CONCENTRATION = 0.4;

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

// Within a severity, the order things are worth reading in: what is going wrong
// first, then what it costs, then what could be better.
const KIND_ORDER = [
  "missed",
  "autopay_short",
  "due",
  "overspend",
  "maxed",
  "interest",
  "autopay_off",
  "pace",
  "hot_category",
  "limit_bump",
  "upgrade",
  "points_ready",
  "points_missed",
  "upgrade_target",
  "score",
  "no_card"
];

const rank = (move) =>
  SEVERITY_ORDER[move.severity] * 100 + Math.max(KIND_ORDER.indexOf(move.kind), 0);

// Where somebody stands, from everything they hold: how they have paid, for how
// long, how long since the last slip, and the score that falls out of it.
//
// Both the application page and the agent read this, so what the agent says you
// are three months short of and what the application refuses you for are the
// same figure by construction rather than by two people remembering to keep two
// files in step.
export function standingFrom({ facilities = [], monthlyIncome = 0, todayIso = toISODate(new Date()) }) {
  // Every year of it, not one: a lender is shown the whole record, and so is the
  // person deciding whether they have earned a better card.
  const record = paymentRecord(facilities, null, todayIso);

  const first = facilities.map((f) => toISODate(f.opened_on)).filter(Boolean).sort()[0];
  const historyMonths = first ? Math.max(monthsBetween(first, todayIso).length - 1, 0) : 0;

  // The last day something went wrong: a statement missed, or an instalment
  // paid after its date or still unpaid past it. Months since then is what a
  // higher limit is earned with, so a slip resets it and time is the only thing
  // that puts it back.
  const slips = [];
  for (const facility of facilities) {
    for (const statement of facility.card?.statements || []) {
      if (statement.missed) slips.push(statement.dueOn);
    }
    for (const installment of facility.installments || []) {
      const due = toISODate(installment.due_on);
      const paid = toISODate(installment.paid_on);
      if (paid && paid > due) slips.push(paid);
      else if (!paid && due < todayIso) slips.push(due);
    }
  }
  const lastSlip = slips.sort().at(-1) || null;
  const cleanMonths = lastSlip
    ? Math.max(monthsBetween(lastSlip, todayIso).length - 1, 0)
    : historyMonths;

  const active = facilities.filter((f) => f.status === "active");
  const cards = active.filter((f) => isCard(f.product) && f.card);
  const limit = round(cards.reduce((sum, f) => sum + f.card.limit, 0));
  const balance = round(cards.reduce((sum, f) => sum + f.card.balance, 0));
  const owed = round(
    active.reduce((sum, f) => sum + (f.standing?.outstanding || 0) + (f.card?.balance || 0), 0)
  );

  // Across every card rather than whichever one came back first: two cards half
  // used are half used, and scoring only one of them would say otherwise.
  const utilisation = limit > 0 ? Math.min(Math.round((balance / limit) * 100), 100) : null;

  return {
    record,
    historyMonths,
    cleanMonths,
    lastSlip,
    owed,
    limit,
    balance,
    utilisation,
    score: creditScore({ record, utilisation, owed, monthlyIncome, historyMonths })
  };
}

// What a card's spending looks like month by month, and what it went on this
// month. Worked out from the charges rather than asked of the database, so the
// same figures come out of a test with three rows in an array.
export function spendingShape(charges = [], todayIso) {
  const thisKey = monthKey(todayIso);
  const byMonth = new Map();
  const byCategory = new Map();

  for (const charge of charges) {
    const key = monthKey(charge.charged_on);
    byMonth.set(key, round((byMonth.get(key) || 0) + Number(charge.amount)));

    if (key === thisKey) {
      const name = charge.category || "Uncategorized";
      const row = byCategory.get(name) || { category: name, total: 0, count: 0 };
      row.total = round(row.total + Number(charge.amount));
      row.count += 1;
      byCategory.set(name, row);
    }
  }

  const months = [...byMonth.entries()]
    .map(([month, total]) => ({ month, total }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const thisMonth = byMonth.get(thisKey) || 0;
  const past = months.filter((m) => m.month < thisKey);
  const lastMonth = past.at(-1) || null;
  const average = past.length
    ? round(past.reduce((sum, m) => sum + m.total, 0) / past.length)
    : 0;

  return {
    months,
    thisMonth,
    lastMonth,
    average,
    categories: [...byCategory.values()].sort((a, b) => b.total - a.total)
  };
}

// How much has to come off a card to bring it back under a share of its limit.
export function payDownTo(standing, targetPercent) {
  const ceiling = standing.limit * (Math.min(Math.max(targetPercent, 0), 100) / 100);
  return round(Math.max(standing.balance - ceiling, 0));
}

// --- The moves ---

function paymentMoves({ cards, settings, wallet, todayIso, push }) {
  for (const card of cards) {
    const standing = card.card;
    const statement = standing.statement;
    if (!statement) continue;

    const owing = round(Math.max(statement.minimumDue - statement.paidTowards, 0));
    const daysLeft = Math.round(
      (Date.parse(`${statement.dueOn}T00:00:00`) - Date.parse(`${todayIso}T00:00:00`)) / 86400000
    );

    if (statement.missed) {
      push({
        severity: "high",
        kind: "missed",
        facilityId: card.id,
        title: `${card.label}: the minimum was missed`,
        detail:
          `${owing.toFixed(2)} was due on ${statement.dueOn} and has not arrived. ` +
          `Every statement that goes by short adds a late fee of a tenth of the gap, ` +
          `and a missed payment is the single heaviest thing against your score.`,
        amount: owing,
        action: { kind: "pay", amount: owing, label: "Pay what is short now" }
      });
      continue;
    }

    push({
      severity: daysLeft <= settings.leadDays ? "high" : "medium",
      kind: "due",
      facilityId: card.id,
      title: `${card.label}: ${owing.toFixed(2)} due by ${statement.dueOn}`,
      detail:
        `The statement drawn ${statement.closedOn} came to ${statement.balance.toFixed(2)}, ` +
        `and ${statement.minimumDue.toFixed(2)} of it has to be paid` +
        (statement.paidTowards > 0 ? ` — ${statement.paidTowards.toFixed(2)} is already in` : "") +
        `. ${daysLeft} day${daysLeft === 1 ? "" : "s"} left. Clearing the whole ` +
        `${standing.balance.toFixed(2)} instead stops the interest altogether.` +
        // The balance rolls forward, so an older statement that went unpaid is
        // already inside this one. Worth saying all the same: it is why the
        // minimum is what it is, and why the score is where it is.
        (standing.missedCount > 0
          ? ` ${standing.missedCount} earlier statement${standing.missedCount === 1 ? " has" : "s have"} ` +
            `gone unpaid, and what they left is carried in this figure.`
          : ""),
      amount: owing,
      action: { kind: "pay", amount: owing, label: "Pay the minimum" },
      alternative: standing.balance > owing
        ? { kind: "pay", amount: standing.balance, label: "Clear the card" }
        : null
    });

    // The agent is meant to be paying this one and cannot. Worth saying loudly:
    // an autopay that quietly does not happen is worse than never having had one.
    if (settings.autopay !== "off" && daysLeft <= settings.leadDays) {
      const owed = settings.autopay === "minimum" ? owing : standing.balance;
      if (!wallet) {
        push({
          severity: "high",
          kind: "autopay_short",
          facilityId: card.id,
          title: "Autopay has no wallet to pay from",
          detail:
            `Autopay is set to pay ${settings.autopay === "minimum" ? "the minimum" : "the balance"}, ` +
            `but no wallet has been chosen, so nothing will be paid. Choose one below.`
        });
      } else if (Number(wallet.balance) < owed) {
        push({
          severity: "high",
          kind: "autopay_short",
          facilityId: card.id,
          title: `${wallet.name} will not cover the autopay`,
          detail:
            `${owed.toFixed(2)} falls due on ${statement.dueOn} and ${wallet.name} holds ` +
            `${Number(wallet.balance).toFixed(2)}. Move money into it, or pay by hand before ` +
            `the date.`
        });
      }
    }
  }
}

function utilisationMoves({ cards, settings, push }) {
  for (const card of cards) {
    const standing = card.card;
    if (standing.limit <= 0 || standing.balance <= 0) continue;

    const used = standing.utilisation;
    if (used <= settings.utilisationTarget) continue;

    const toTarget = payDownTo(standing, settings.utilisationTarget);
    push({
      severity: used >= NEARLY_MAXED ? "high" : "medium",
      kind: "maxed",
      facilityId: card.id,
      title: used >= NEARLY_MAXED
        ? `${card.label} is all but maxed out — ${used}% used`
        : `${card.label} is ${used}% used, over your ${settings.utilisationTarget}% line`,
      detail:
        `${standing.balance.toFixed(2)} of a ${standing.limit.toFixed(2)} limit is in use, ` +
        `leaving ${standing.available.toFixed(2)} to spend. Paying ${toTarget.toFixed(2)} brings ` +
        `it back to ${settings.utilisationTarget}%` +
        (used >= NEARLY_MAXED
          ? ", and a card this close to its limit is the fastest thing to fix in your score."
          : ". How much of a limit is in use is worth a fifth of your score here."),
      amount: toTarget,
      action: { kind: "pay", amount: toTarget, label: `Pay down to ${settings.utilisationTarget}%` }
    });
  }
}

function interestMoves({ cards, push }) {
  for (const card of cards) {
    const standing = card.card;
    if (standing.balance <= 0 || standing.monthlyInterest <= 0) continue;
    // Already said, and more urgently, by a statement that is due or missed.
    if (standing.statement) continue;

    push({
      severity: "medium",
      kind: "interest",
      facilityId: card.id,
      title: `Carrying ${standing.balance.toFixed(2)} on ${card.label} costs ` +
        `${standing.monthlyInterest.toFixed(2)} a month`,
      detail:
        `At ${Number(card.apr).toFixed(0)}% APR, anything still on the card when the month ends ` +
        `starts earning interest. Clearing it before then costs nothing at all` +
        (standing.interestCharged > 0
          ? `; ${standing.interestCharged.toFixed(2)} has gone in interest so far.`
          : "."),
      amount: standing.balance,
      action: { kind: "pay", amount: standing.balance, label: "Clear it before month end" }
    });
  }
}

function habitMoves({ spend, means, push }) {
  if (spend.thisMonth <= 0) return;

  // Spending more on the card in a month than there is spare to clear it with is
  // the point at which a card stops being a way to pay and starts being a debt.
  if (means.disposable > 0 && spend.thisMonth > means.disposable) {
    push({
      severity: "high",
      kind: "overspend",
      title: `This month's card spending is more than you have spare`,
      detail:
        `${spend.thisMonth.toFixed(2)} has gone on the cards this month against ` +
        `${means.disposable.toFixed(2)} spare after everything you already spend and owe. ` +
        `What cannot be cleared gets carried, and carried is what costs.`
    });
  }

  if (spend.lastMonth && spend.lastMonth.total > 0) {
    const change = (spend.thisMonth - spend.lastMonth.total) / spend.lastMonth.total;
    if (change >= PACE_RISE && spend.thisMonth - spend.lastMonth.total > 0) {
      push({
        severity: "medium",
        kind: "pace",
        title: `Card spending is up ${Math.round(change * 100)}% on last month`,
        detail:
          `${spend.thisMonth.toFixed(2)} so far against ${spend.lastMonth.total.toFixed(2)} ` +
          `for all of ${spend.lastMonth.month}` +
          (spend.average > 0 ? `, on an average of ${spend.average.toFixed(2)}.` : ".") +
          ` The month is not over, so this is the part of it you can still change.`
      });
    }
  }

  const top = spend.categories[0];
  if (top && spend.thisMonth > 0 && top.total / spend.thisMonth >= CONCENTRATION) {
    push({
      severity: "low",
      kind: "hot_category",
      title: `${top.category} is ${Math.round((top.total / spend.thisMonth) * 100)}% of what went on the cards`,
      detail:
        `${top.total.toFixed(2)} across ${top.count} purchase${top.count === 1 ? "" : "s"} this month. ` +
        `Not a problem in itself — but it is the one category where cutting would show.`
    });
  }
}

function pointsMoves({ cards, missed, push }) {
  for (const card of cards) {
    const points = card.points;
    if (!points || !points.redeemable) continue;

    push({
      severity: "low",
      kind: "points_ready",
      facilityId: card.id,
      title: `${points.balance} points on ${card.label} are worth ${points.worth.toFixed(2)}`,
      detail:
        `Redeeming takes them straight off the balance, which is the only thing they do here — ` +
        `so there is nothing gained by saving them, and a balance they could have paid down is ` +
        `earning interest in the meantime.`,
      amount: points.worth,
      action: { kind: "redeem", points: points.balance, label: "Redeem against the balance" }
    });
  }

  if (missed.total > 0) {
    const worst = missed.byCategory[0];
    push({
      severity: "low",
      kind: "points_missed",
      title: `${missed.total} points left on the table`,
      detail:
        `${worst.spent.toFixed(2)} of ${worst.category} went on a card earning less than ` +
        `${worst.use.label} does for it — that alone cost ${worst.lost} points. ` +
        `Which card you reach for is the whole of the difference; nothing else has to change.`,
      hint: missed.byCategory.slice(0, 3).map((row) => ({
        category: row.category,
        use: row.use.label,
        lost: row.lost
      }))
    });
  }
}

function cardMoves({ cards, path, bumps, push }) {
  if (cards.length === 0) {
    push({
      severity: "low",
      kind: "no_card",
      title: "There is no card open here yet",
      detail:
        "A secured card is where a record starts: the limit is a deposit you put up yourself, " +
        "it comes back when you close the card, and paying it on time is what earns everything " +
        "above it.",
      action: { kind: "open", label: "Open a secured card" }
    });
    return;
  }

  for (const bump of bumps) {
    push({
      severity: "medium",
      kind: "limit_bump",
      facilityId: bump.card.id,
      title: `${bump.card.label} is due a limit of ${bump.entitled.toFixed(2)}`,
      detail:
        `${bump.reason} That is ${bump.raise.toFixed(2)} more than the ` +
        `${bump.current.toFixed(2)} it carries now` +
        (bump.utilisationAfter !== null
          ? `, and it would drop what you are using from ${bump.utilisationBefore}% to ` +
            `${bump.utilisationAfter}% without paying a shilling.`
          : "."),
      action: { kind: "raise_limit", label: "Take the higher limit" }
    });
  }

  if (path.offer) {
    push({
      severity: "medium",
      kind: "upgrade",
      title: `You qualify for the ${path.offer.label.toLowerCase()}`,
      detail:
        `${path.offer.reason} It carries ${path.offer.apr}% APR against the ` +
        `${CARDS[path.held]?.apr ?? "current"}% you pay now, a limit of about ` +
        `${(path.offer.limit || 0).toFixed(2)}, and ${describeEarn(path.offer)}. ` +
        `No deposit.`,
      action: { kind: "apply", product: path.offer.product, label: `Apply for the ${path.offer.label.toLowerCase()}` }
    });
  }

  if (path.next) {
    push({
      severity: "low",
      kind: "upgrade_target",
      title: `The ${path.next.label.toLowerCase()} is the next one up`,
      detail: `${path.next.reason} It would put you on ${path.next.apr}% APR and ` +
        `${describeEarn(path.next)}.`
    });
  }
}

// "double points on food, one everywhere else" — the earn table in a sentence.
function describeEarn(card) {
  const bonus = Object.entries(card.earn.bonus);
  const base = `${card.earn.base}${card.earn.base === 1 ? " point" : " points"} per ` +
    `100 spent`;
  if (bonus.length === 0) return base;

  const parts = bonus
    .sort((a, b) => b[1] - a[1])
    .map(([category, rate]) => `${rate}× on ${category.toLowerCase()}`);
  return `${parts.join(", ")}, and ${base} on everything else`;
}

function scoreMoves({ score, push }) {
  if (!score || score.score === null) return;

  const weakest = [...(score.parts || [])].sort(
    (a, b) => (b.max - b.points) - (a.max - a.points)
  )[0];
  if (!weakest || weakest.max - weakest.points <= 0) return;

  push({
    severity: "low",
    kind: "score",
    title: `Your score is ${score.score} out of 100 — ${score.band}`,
    detail: `${weakest.label} is where the most is left on the table: ${weakest.detail}. ` +
      `That part is worth ${weakest.max} of the score and you have ${weakest.points} of it.`
  });
}

// --- The run ---

// Everything the agent has to say, in the order it is worth hearing. The caller
// has already read the rows; this only decides what they mean.
export function reviewCards({
  cards = [],
  means = { income: 0, expenses: 0, commitments: 0, disposable: 0 },
  score = null,
  record = null,
  historyMonths = 0,
  cleanMonths = 0,
  charges = [],
  redemptionsByFacility = new Map(),
  settings = {},
  accounts = [],
  todayIso = toISODate(new Date())
}) {
  const active = cards.filter((c) => isCard(c.product) && c.status === "active");
  const resolved = {
    autopay: settings.autopay || "off",
    leadDays: Number(settings.lead_days ?? settings.leadDays ?? 3),
    utilisationTarget: Number(settings.utilisation_target ?? settings.utilisationTarget ?? 30),
    chargeGuard: Boolean(settings.charge_guard ?? settings.chargeGuard ?? false)
  };

  const walletId = settings.autopay_account_id ?? settings.autopayAccountId ?? null;
  const wallet = accounts.find((a) => a.id === walletId) || null;

  // Points are per card, earned from that card's own charges and redeemed
  // against that card's own balance, which is what a card's points are.
  const withPoints = active.map((card) => ({
    ...card,
    points: pointsStanding(
      card.product,
      charges.filter((c) => c.facility_id === card.id),
      redemptionsByFacility.get(card.id) || []
    )
  }));

  const spend = spendingShape(charges, todayIso);
  // Asked of the cards with their standings attached rather than of the raw
  // rows, so the card it names back is the one the holder calls it by.
  const missed = pointsMissed({ cards: withPoints, charges });

  const path = upgradePath({
    score: score?.score ?? null,
    historyMonths,
    cleanMonths,
    record,
    held: cards,
    monthlyIncome: means.income
  });

  const bumps = [];
  for (const card of withPoints) {
    const offer = limitIncrease({
      facility: card,
      monthlyIncome: means.income,
      cleanMonths
    });
    if (!offer.eligible) continue;
    bumps.push({
      card,
      ...offer,
      utilisationBefore: card.card.utilisation,
      utilisationAfter: offer.entitled > 0
        ? Math.min(Math.round((card.card.balance / offer.entitled) * 100), 100)
        : null
    });
  }

  const moves = [];
  const push = (move) => moves.push(move);

  paymentMoves({ cards: withPoints, settings: resolved, wallet, todayIso, push });
  utilisationMoves({ cards: withPoints, settings: resolved, push });
  interestMoves({ cards: withPoints, push });
  habitMoves({ spend, means, push });
  pointsMoves({ cards: withPoints, missed, push });
  cardMoves({ cards: withPoints, path, bumps, push });
  scoreMoves({ score, push });

  // Worth saying only once there is something for it to be watching over.
  if (resolved.autopay === "off" && withPoints.some((c) => c.card.balance > 0)) {
    push({
      severity: "medium",
      kind: "autopay_off",
      title: "Nothing is paying these cards but you",
      detail:
        `Switch autopay on and the minimum — or the whole statement — leaves the wallet you ` +
        `choose ${resolved.leadDays} days before the date, every cycle, whether or not you ` +
        `opened this page. A missed payment costs a late fee and the heaviest part of your score; ` +
        `neither is worth the risk of a busy week.`
    });
  }

  moves.sort((a, b) => rank(a) - rank(b));

  const counts = {
    total: moves.length,
    high: moves.filter((m) => m.severity === "high").length,
    medium: moves.filter((m) => m.severity === "medium").length,
    low: moves.filter((m) => m.severity === "low").length
  };

  const balance = round(withPoints.reduce((sum, c) => sum + c.card.balance, 0));
  const limit = round(withPoints.reduce((sum, c) => sum + c.card.limit, 0));

  return {
    cards: withPoints,
    moves,
    counts,
    spend,
    points: {
      balance: withPoints.reduce((sum, c) => sum + c.points.balance, 0),
      earned: withPoints.reduce((sum, c) => sum + c.points.earned, 0),
      worth: round(withPoints.reduce((sum, c) => sum + c.points.worth, 0)),
      missed
    },
    path,
    bumps,
    balance,
    limit,
    utilisation: limit > 0 ? Math.min(Math.round((balance / limit) * 100), 100) : 0,
    settings: resolved,
    wallet,
    // Where things stand in one word, from the worst thing outstanding.
    health: counts.high > 0 ? "at risk" : counts.medium > 0 ? "watch" : "on track",
    clean: moves.length === 0
  };
}
