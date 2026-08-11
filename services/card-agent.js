import { config } from "../config/env.js";

// The card agent's voice.
//
// Same division of labour as the accountant keeps: utils/card-agent.js decides
// what is true and what to do about it, and this module only puts it into words
// and answers questions about it. An AI is good at both of those jobs and must
// never be trusted with the first — "pay 4,312.80 by the 21st" has to be
// reproducible from the statement it came from, and a model cannot promise that.
//
// Without a provider configured the agent still works and still speaks; it just
// says it in sentences assembled here rather than written. Nothing it can do
// depends on the provider being there, which is the point: an agent that stops
// paying your card when an API key expires is worse than no agent.

export function aiEnabled() {
  return Boolean(config.ai.apiKey && config.ai.baseUrl && config.ai.model);
}

async function callProvider({ system, user, maxTokens = 600, temperature = 0.3 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(`${config.ai.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.ai.apiKey}`
      },
      body: JSON.stringify({
        model: config.ai.model,
        max_tokens: maxTokens,
        temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`provider responded ${res.status}`);
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("empty response");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Everything the agent knows, in plain text, so an answer can only ever be
// grounded in figures that are already on the page.
export function briefing(review, fmt) {
  const lines = [
    `CARDS (${review.cards.length} open):`
  ];

  if (review.cards.length === 0) {
    lines.push("  None.");
  } else {
    for (const card of review.cards) {
      const s = card.card;
      lines.push(
        `  ${card.label} — limit ${fmt(s.limit)}, owing ${fmt(s.balance)} ` +
        `(${s.utilisation}% used), ${fmt(s.available)} left to spend, ${Number(card.apr).toFixed(0)}% APR.`
      );
      if (s.statement) {
        lines.push(
          `    Statement drawn ${s.statement.closedOn} for ${fmt(s.statement.balance)}; ` +
          `minimum ${fmt(s.minimumDue)} due ${s.dueOn}` +
          `${s.statement.missed ? " — MISSED" : ""}.`
        );
      }
      lines.push(
        `    Interest charged so far ${fmt(s.interestCharged)}, late fees ${fmt(s.lateFeesCharged)}. ` +
        `Points: ${card.points.balance} (worth ${fmt(card.points.worth)}).`
      );
    }
  }

  lines.push(
    "",
    "ACROSS ALL CARDS:",
    `  Owing ${fmt(review.balance)} of ${fmt(review.limit)} — ${review.utilisation}% used ` +
      `(target ${review.settings.utilisationTarget}%).`,
    `  Points balance ${review.points.balance}, worth ${fmt(review.points.worth)}.` +
      (review.points.missed.total > 0
        ? ` ${review.points.missed.total} points went uncollected by using the wrong card.`
        : ""),
    "",
    "SPENDING ON THE CARDS:",
    `  This month ${fmt(review.spend.thisMonth)}` +
      (review.spend.lastMonth ? `, last month ${fmt(review.spend.lastMonth.total)}` : "") +
      (review.spend.average > 0 ? `, average ${fmt(review.spend.average)}` : "") + ".",
    ...review.spend.categories
      .slice(0, 5)
      .map((c) => `  ${c.category}: ${fmt(c.total)} over ${c.count} purchase(s)`),
    "",
    "AUTOPILOT:",
    `  Autopay: ${review.settings.autopay}` +
      (review.wallet ? ` from ${review.wallet.name} (holds ${fmt(review.wallet.balance)})` : ", no wallet chosen") +
      `, ${review.settings.leadDays} days before the date.`,
    `  Charge guard: ${review.settings.chargeGuard ? "on" : "off"}.`,
    "",
    `MOVES (${review.counts.total}: ${review.counts.high} urgent, ${review.counts.medium} worth doing):`
  );

  if (review.moves.length === 0) {
    lines.push("  Nothing to do — everything is where it should be.");
  } else {
    for (const move of review.moves) {
      lines.push(`  [${move.severity}] ${move.title} — ${move.detail}`);
    }
  }

  return lines.join("\n");
}

// Assembled here when no provider is configured. Structured rather than chatty,
// but it says the same things in the same order.
function offlineNarrative(review, fmt) {
  const parts = [];

  if (review.counts.high > 0) {
    const urgent = review.moves.filter((m) => m.severity === "high");
    parts.push(
      `${urgent.length} thing${urgent.length === 1 ? "" : "s"} need${urgent.length === 1 ? "s" : ""} ` +
      `doing now: ${urgent.map((m) => m.title).join("; ")}.`
    );
  } else if (review.counts.total > 0) {
    parts.push("Nothing is going wrong, but there is money to be saved and points to be had.");
  } else if (review.cards.length === 0) {
    parts.push("There is no card open here yet, so there is nothing to manage.");
  } else {
    parts.push("Everything is where it should be — paid up, well under the limits, nothing owed late.");
  }

  if (review.cards.length > 0) {
    parts.push(
      `You owe ${fmt(review.balance)} across ${review.cards.length} card` +
      `${review.cards.length === 1 ? "" : "s"}, which is ${review.utilisation}% of ` +
      `${fmt(review.limit)} of limit` +
      (review.utilisation > review.settings.utilisationTarget
        ? ` — above the ${review.settings.utilisationTarget}% you asked me to hold you to.`
        : review.utilisation === review.settings.utilisationTarget
          // Exactly on the line is not under it, and saying "comfortably under"
          // to somebody sitting on their own limit is the sort of reassurance
          // that costs them the next month.
          ? ` — exactly the ${review.settings.utilisationTarget}% you asked me to hold you to, with no room left.`
          : `, comfortably under the ${review.settings.utilisationTarget}% you asked for.`)
    );
  }

  if (review.points.balance > 0) {
    parts.push(
      `You are sitting on ${review.points.balance} points, worth ${fmt(review.points.worth)} off a balance` +
      (review.points.missed.total > 0
        ? `, and left ${review.points.missed.total} more uncollected by reaching for the wrong card.`
        : ".")
    );
  }

  const next = review.moves.filter((m) => m.severity !== "high").slice(0, 2);
  if (next.length > 0) {
    parts.push(`After that: ${next.map((m) => m.title).join("; ")}.`);
  }

  return parts.join(" ");
}

// The covering note on a run. Any failure falls back rather than surfacing —
// the moves are still worth having without prose over them.
export async function narrate({ review, fmt }) {
  if (!aiEnabled()) {
    return { text: offlineNarrative(review, fmt), mode: "offline" };
  }

  const system =
    "You are the card agent inside somebody's own budgeting app: the thing that watches their " +
    "credit cards, pays them on time, and keeps them off the limit. Write the note that goes " +
    "at the top of today's run, addressed to the holder, in at most 130 words. Lead with " +
    "whatever is actually at risk, say plainly what you would do about it, and be specific " +
    "about amounts and dates. Every figure you need is below — use those exact numbers and " +
    "never invent, re-derive or round them differently. Do not moralise about their spending, " +
    "do not give financial or legal advice, and do not mention what model or service you are." +
    `\n\n${briefing(review, fmt)}`;

  try {
    const text = await callProvider({ system, user: "Write today's note." });
    return { text, mode: "ai" };
  } catch (error) {
    console.warn(`Card agent: AI provider unavailable (${error.message})`);
    return { text: offlineNarrative(review, fmt), mode: "offline" };
  }
}

// --- Questions ---

// Answers without a provider: match what was asked to the figures that answer it.
export function heuristicAnswer(question, review, fmt) {
  const q = question.toLowerCase();
  const has = (...words) => words.some((w) => q.includes(w));
  const card = review.cards[0] || null;

  if (review.cards.length === 0) {
    return "There is no card open here yet. A secured card is where a record starts — the limit " +
      "is a deposit you put up yourself and it comes back when you close the card.";
  }

  if (has("due", "when", "pay", "payment", "late", "miss", "minimum")) {
    const owing = review.moves.filter((m) => m.kind === "due" || m.kind === "missed");
    if (owing.length === 0) {
      return `Nothing is due. ${review.cards
        .map((c) => `${c.label} owes ${fmt(c.card.balance)}`)
        .join(", ")} — no statement is asking for anything right now.`;
    }
    return owing.map((m) => `${m.title}. ${m.detail}`).join(" ");
  }

  // "maxing" as well as "maxed": the question people actually ask is "am I
  // close to maxing out", and matching only the past tense sent it to the
  // catch-all, which answered something true but not what was asked.
  if (has("limit", "maxed", "maxing", "max out", "utilisation", "utilization",
          "how much left", "how close", "available")) {
    return review.cards
      .map((c) => `${c.label}: ${fmt(c.card.balance)} of ${fmt(c.card.limit)} used ` +
        `(${c.card.utilisation}%), ${fmt(c.card.available)} left to spend.`)
      .join(" ") +
      ` Your line is ${review.settings.utilisationTarget}%, and across everything you are at ` +
      `${review.utilisation}%.`;
  }

  if (has("point", "reward", "earn", "cashback", "cash back", "redeem", "which card")) {
    const missed = review.points.missed;
    let text = `You have ${review.points.balance} points, worth ${fmt(review.points.worth)} off a balance.`;
    if (missed.total > 0) {
      text += ` You left ${missed.total} uncollected: ` +
        missed.byCategory
          .slice(0, 3)
          .map((row) => `put ${row.category.toLowerCase()} on ${row.use.label} (${row.lost} points)`)
          .join(", ") + ".";
    } else {
      text += " Everything went on the card that earns the most for it.";
    }
    return text;
  }

  if (has("score", "credit rating", "rating", "improve", "better credit")) {
    const move = review.moves.find((m) => m.kind === "score");
    if (move) return `${move.title}. ${move.detail}`;
    return "There is not enough history here to score yet. Paying a card on time for a few " +
      "months is what builds one.";
  }

  if (has("upgrade", "better card", "new card", "apr", "interest rate", "qualify", "eligible")) {
    if (review.path.offer) {
      const move = review.moves.find((m) => m.kind === "upgrade");
      return move ? `${move.title}. ${move.detail}` : review.path.offer.reason;
    }
    if (review.path.next) {
      return `The ${review.path.next.label.toLowerCase()} is next. ${review.path.next.reason}`;
    }
    return "You already hold the best card here.";
  }

  if (has("interest", "cost", "carrying", "apr")) {
    const carried = review.cards.filter((c) => c.card.balance > 0);
    if (carried.length === 0) return "Nothing is carried, so nothing is costing you interest.";
    return carried
      .map((c) => `${c.label} costs ${fmt(c.card.monthlyInterest)} next month on ` +
        `${fmt(c.card.balance)} at ${Number(c.apr).toFixed(0)}% APR` +
        (c.card.interestCharged > 0 ? `; ${fmt(c.card.interestCharged)} has gone in interest so far` : "") + ".")
      .join(" ") + " Clearing a balance before the month ends costs nothing at all.";
  }

  if (has("spend", "spending", "habit", "budget", "month", "where", "category")) {
    const top = review.spend.categories.slice(0, 3)
      .map((c) => `${c.category} ${fmt(c.total)}`)
      .join(", ");
    return `${fmt(review.spend.thisMonth)} has gone on the cards this month` +
      (review.spend.lastMonth ? ` against ${fmt(review.spend.lastMonth.total)} last month` : "") +
      (top ? `. Biggest: ${top}.` : ".");
  }

  if (has("autopay", "automatic", "auto pay", "on my behalf", "do it for me")) {
    return review.settings.autopay === "off"
      ? "Autopay is off, so nothing is paying these cards but you. Turn it on and I will pay " +
        `the minimum — or the whole statement — ${review.settings.leadDays} days before each date.`
      : `Autopay is on: I pay ${review.settings.autopay === "minimum" ? "the minimum" : "the balance"} ` +
        `${review.settings.leadDays} days before the date` +
        (review.wallet ? ` out of ${review.wallet.name}.` : ", but no wallet is chosen, so nothing can leave.");
  }

  // Where things stand, and what to do first.
  const first = review.moves[0];
  return `You owe ${fmt(review.balance)} of ${fmt(review.limit)} in limits — ${review.utilisation}% used — ` +
    `with ${review.points.balance} points banked.` +
    (first ? ` First thing to do: ${first.title.toLowerCase()}. ${first.detail}` : " Nothing needs doing.") +
    " Ask me about payments due, limits, points, your score, a better card, or where the money went.";
}

export async function ask(question, review, fmt) {
  if (!aiEnabled()) {
    return { text: heuristicAnswer(question, review, fmt), mode: "offline" };
  }

  const system =
    "You are the card agent inside somebody's own budgeting app. Answer the holder's question " +
    "about their credit cards concisely and practically, using the figures below and citing " +
    "the specific numbers. If the figures do not cover what they asked, say so in a sentence " +
    "rather than guessing. Never invent an amount, a date or a rate. Do not give financial or " +
    "legal advice, and do not mention what model or service you are." +
    `\n\n${briefing(review, fmt)}`;

  try {
    const text = await callProvider({ system, user: question, maxTokens: 500 });
    return { text, mode: "ai" };
  } catch (error) {
    console.warn(`Card agent: AI provider unavailable (${error.message})`);
    return { text: heuristicAnswer(question, review, fmt), mode: "offline" };
  }
}
