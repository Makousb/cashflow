// The sales pipeline and the support desk.
//
// The marketing side already knows who people are: contacts, how they arrived,
// and a lifecycle stage derived from what they have done (see utils/marketing.js
// — its STAGES are about the PERSON, lead through lapsed). What was missing is
// the two things a business actually works on day to day: the deals it is
// chasing, and the problems it owes somebody an answer to.
//
// Both hang off the existing contacts rather than starting a second address
// book. A deal or a case can also stand alone — a walk-in has no contact row and
// refusing to record their complaint until they hand over an email would be a
// worse app, not a tidier one.
//
// Pure. Rows in, plain objects out.

const round = (n) => Math.round(Number(n) * 100) / 100;

// Where a deal can be, and what each stage is worth as a forecast.
//
// The probabilities are the ordinary ones and they are deliberately blunt: a
// weighted forecast is a way of not fooling yourself about a pipeline full of
// early-stage hope, not a prediction. The owner can override the odds on any
// single deal; these are what it starts at.
export const PIPELINE_STAGES = {
  lead: { label: "Lead", probability: 10, open: true, order: 1 },
  qualified: { label: "Qualified", probability: 30, open: true, order: 2 },
  proposal: { label: "Proposal sent", probability: 60, open: true, order: 3 },
  negotiation: { label: "Negotiating", probability: 80, open: true, order: 4 },
  won: { label: "Won", probability: 100, open: false, order: 5 },
  lost: { label: "Lost", probability: 0, open: false, order: 6 }
};

export const STAGE_KEYS = Object.keys(PIPELINE_STAGES)
  .sort((a, b) => PIPELINE_STAGES[a].order - PIPELINE_STAGES[b].order);

export const isStage = (stage) => Object.hasOwn(PIPELINE_STAGES, stage);
export const isOpen = (stage) => Boolean(PIPELINE_STAGES[stage]?.open);

// What a deal is worth to a forecast: its value against its odds. An explicit
// probability wins over the stage's, because the person working the deal knows
// something the stage does not.
export function weightedValue(opportunity) {
  const stage = PIPELINE_STAGES[opportunity.stage];
  if (!stage) return 0;
  const odds = opportunity.probability == null
    ? stage.probability
    : Math.min(Math.max(Number(opportunity.probability), 0), 100);
  return round(Number(opportunity.value || 0) * (odds / 100));
}

// The pipeline as a whole: what is open, what it is worth flat, and what it is
// worth once the odds are taken seriously. The gap between those last two is
// the useful number — a business with 5m "in the pipeline" and 400k weighted
// does not have 5m coming.
export function pipeline(opportunities = []) {
  const byStage = STAGE_KEYS.map((key) => {
    const rows = opportunities.filter((o) => o.stage === key);
    return {
      stage: key,
      ...PIPELINE_STAGES[key],
      count: rows.length,
      value: round(rows.reduce((sum, o) => sum + Number(o.value || 0), 0)),
      weighted: round(rows.reduce((sum, o) => sum + weightedValue(o), 0)),
      rows
    };
  });

  const open = opportunities.filter((o) => isOpen(o.stage));
  const won = opportunities.filter((o) => o.stage === "won");
  const lost = opportunities.filter((o) => o.stage === "lost");
  const decided = won.length + lost.length;

  return {
    byStage,
    // Only the open stages are a forecast. Counting won deals as "pipeline"
    // is how a quarter gets called twice.
    open: {
      count: open.length,
      value: round(open.reduce((sum, o) => sum + Number(o.value || 0), 0)),
      weighted: round(open.reduce((sum, o) => sum + weightedValue(o), 0))
    },
    won: { count: won.length, value: round(won.reduce((sum, o) => sum + Number(o.value || 0), 0)) },
    lost: { count: lost.length, value: round(lost.reduce((sum, o) => sum + Number(o.value || 0), 0)) },
    // Of the deals that were actually decided. Open ones are not evidence
    // either way, so leaving them out is the only honest denominator.
    winRate: decided > 0 ? Math.round((won.length / decided) * 100) : null,
    decided
  };
}

// Deals that have gone quiet or blown their date, worst first. A pipeline's
// real problem is rarely the deals being worked — it is the ones nobody has
// touched since March and nobody wants to call dead.
export function needsAttention(opportunities = [], todayIso, staleDays = 21) {
  const flagged = [];

  for (const o of opportunities) {
    if (!isOpen(o.stage)) continue;

    const idle = daysBetween(o.updated_on || o.created_on, todayIso);
    const overdue = o.expected_close && o.expected_close < todayIso;

    if (overdue) {
      flagged.push({
        ...o,
        reason: `The close date of ${o.expected_close} has gone by`,
        idle,
        severity: "high"
      });
    } else if (idle !== null && idle >= staleDays) {
      flagged.push({
        ...o,
        reason: `Nothing has moved on this for ${idle} days`,
        idle,
        severity: "medium"
      });
    }
  }

  return flagged.sort((a, b) => (b.idle || 0) - (a.idle || 0));
}

function daysBetween(from, to) {
  if (!from || !to) return null;
  const a = Date.parse(`${String(from).slice(0, 10)}T00:00:00`);
  const b = Date.parse(`${String(to).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

// --- Support ---

// How long a case of each priority may sit before it is late. Hours rather than
// days for the urgent end, because "we'll get to it tomorrow" is not an answer
// to somebody whose till is down.
export const CASE_PRIORITIES = {
  urgent: { label: "Urgent", hours: 4, order: 1 },
  high: { label: "High", hours: 24, order: 2 },
  normal: { label: "Normal", hours: 72, order: 3 },
  low: { label: "Low", hours: 168, order: 4 }
};

export const CASE_STATUSES = {
  open: { label: "Open", active: true },
  pending: { label: "Waiting on customer", active: true },
  resolved: { label: "Resolved", active: false },
  closed: { label: "Closed", active: false }
};

export const isPriority = (p) => Object.hasOwn(CASE_PRIORITIES, p);
export const isStatus = (s) => Object.hasOwn(CASE_STATUSES, s);
export const isActive = (s) => Boolean(CASE_STATUSES[s]?.active);

// Whether a case has been left longer than its priority allows, and by how
// much. A case waiting on the customer is not late — the clock is not ours.
export function caseStanding(row, now = new Date()) {
  const priority = CASE_PRIORITIES[row.priority] || CASE_PRIORITIES.normal;
  const opened = new Date(row.created_at);
  const ageHours = Math.max((now - opened) / 3600000, 0);

  const waiting = row.status === "pending";
  const settled = !isActive(row.status);
  const late = !settled && !waiting && ageHours > priority.hours;

  return {
    ageHours: Math.round(ageHours),
    ageLabel: ageHours < 24
      ? `${Math.round(ageHours)}h`
      : `${Math.round(ageHours / 24)}d`,
    target: priority.hours,
    late,
    overBy: late ? Math.round(ageHours - priority.hours) : 0,
    settled,
    waiting
  };
}

// The desk, in the order somebody should work it: late first, then by priority,
// then oldest. Settled cases fall to the bottom rather than out of sight —
// "what did we tell them last time" is the commonest question a desk gets.
export function caseBoard(cases = [], now = new Date()) {
  const rows = cases.map((row) => ({ ...row, standing: caseStanding(row, now) }));

  rows.sort((a, b) => {
    if (a.standing.settled !== b.standing.settled) return a.standing.settled ? 1 : -1;
    if (a.standing.late !== b.standing.late) return a.standing.late ? -1 : 1;
    const priority = (CASE_PRIORITIES[a.priority]?.order ?? 9) -
      (CASE_PRIORITIES[b.priority]?.order ?? 9);
    if (priority !== 0) return priority;
    return b.standing.ageHours - a.standing.ageHours;
  });

  const active = rows.filter((r) => !r.standing.settled);
  return {
    rows,
    active,
    counts: {
      total: rows.length,
      open: rows.filter((r) => r.status === "open").length,
      pending: rows.filter((r) => r.status === "pending").length,
      late: rows.filter((r) => r.standing.late).length,
      settled: rows.filter((r) => r.standing.settled).length
    },
    // The one number a desk is judged on.
    oldestActive: active.at(-1) || null
  };
}
