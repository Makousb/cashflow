import { config } from "../config/env.js";

// The accounting agent's voice.
//
// The division of labour matters here. utils/accounting.js computes every
// figure and every finding; this module only puts them into words, and proposes
// a category for entries that have none. An AI is good at the second job and
// must never be trusted with the first — a tax figure has to be reproducible
// from the rows it came from, and a model cannot promise that.
//
// Where the model does feed a change back into the books, its answer is checked
// against a fixed list before it is allowed anywhere near an UPDATE.

export function aiEnabled() {
  return Boolean(config.ai.apiKey && config.ai.baseUrl && config.ai.model);
}

async function callProvider({ system, user, maxTokens = 700, temperature = 0.2 }) {
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

// --- The covering note ---

function briefing(business, tax, review, fmt) {
  const lines = [
    `Business: ${business.name}${business.industry ? ` (${business.industry})` : ""}`,
    "",
    "TAX POSITION (computed by the app, not by you):",
    `  Taxable profit (accrual): ${fmt(tax.taxableProfit)}`,
    `  Income tax at ${tax.rate}%: ${fmt(tax.incomeTax)}`,
    `  Payroll deductions to remit: ${fmt(tax.remittances)}`,
    `  Total owed: ${fmt(tax.totalOwed)}`,
    `  Already set aside: ${fmt(tax.setAside)} (${tax.coverage.toFixed(0)}% covered)`,
    `  Shortfall: ${fmt(tax.shortfall)}`,
    "",
    `FINDINGS (${review.counts.total}: ${review.counts.high} high, ${review.counts.medium} medium):`
  ];

  if (review.findings.length === 0) {
    lines.push("  Nothing found — the books look tidy.");
  } else {
    for (const f of review.findings) {
      lines.push(`  [${f.severity}] ${f.title} — ${f.detail}`);
    }
  }

  return lines.join("\n");
}

// Written here when no provider is configured. Structured rather than chatty,
// but it says the same things.
function offlineNarrative(business, tax, review, fmt) {
  const parts = [];

  if (review.counts.high > 0) {
    parts.push(
      `${review.counts.high} thing${review.counts.high === 1 ? "" : "s"} need attention before ` +
        `these books can be called closed.`
    );
  } else if (review.counts.total > 0) {
    parts.push("Nothing urgent, but a few things are worth tidying.");
  } else {
    parts.push("The books are clean — nothing to correct this time.");
  }

  if (tax.totalOwed > 0) {
    parts.push(
      `On ${fmt(tax.taxableProfit)} of taxable profit the position is ${fmt(tax.totalOwed)} ` +
        `— ${fmt(tax.incomeTax)} income tax at ${tax.rate}% plus ${fmt(tax.remittances)} of ` +
        `payroll deductions to remit.` +
        (tax.shortfall > 0
          ? ` ${fmt(tax.setAside)} is set aside, leaving ${fmt(tax.shortfall)} to find.`
          : ` It is fully covered by the ${fmt(tax.setAside)} already set aside.`)
    );
  } else {
    parts.push("There is no tax to provide for: the business has not turned a taxable profit yet.");
  }

  const top = review.findings.slice(0, 3);
  if (top.length > 0) {
    // Titles are left as written — lowercasing them mangles currency symbols.
    parts.push(`Start with: ${top.map((f) => f.title).join("; ")}.`);
  }

  return parts.join(" ");
}

// Ask the provider to write the note. Any failure falls back rather than
// surfacing an error — a review is still useful without prose.
export async function narrate({ business, tax, review, fmt }) {
  if (!aiEnabled()) {
    return { text: offlineNarrative(business, tax, review, fmt), mode: "offline" };
  }

  const system =
    `You are the accountant for ${business.name}, a small business, writing the covering ` +
    `note on a set of books you have just reviewed inside their accounting app. Address ` +
    `the owner directly and plainly, in at most 150 words. Lead with what actually ` +
    `matters, say what you would do about it, and be specific about amounts. Every ` +
    `figure you need is below — use those exact numbers and never invent, re-derive or ` +
    `round them differently. Do not give filing or legal advice, and do not mention what ` +
    `model or service you are.\n\n${briefing(business, tax, review, fmt)}`;

  try {
    const text = await callProvider({
      system,
      user: "Write the covering note for this review."
    });
    return { text, mode: "ai" };
  } catch (error) {
    console.warn(`Accountant: AI provider unavailable (${error.message})`);
    return { text: offlineNarrative(business, tax, review, fmt), mode: "offline" };
  }
}

// --- Proposing a category for entries that have none ---

// Used when there is no provider, and as the floor under the model's answer.
// Every target here is a real category from the app's own list; anything else
// would be silently dropped by the guard below.
const RULES = [
  [/\brent\b|landlord|lease/i, "Rent"],
  [/power|electric|water|utility|utilities|internet|wifi|airtime/i, "Utilities"],
  [/wage|salary|salaries|payroll|staff/i, "Payroll"],
  [/stock|supplier|wholesale|goods|inventory|restock/i, "Inventory Purchase"],
  [/fuel|petrol|diesel|matatu|transport|delivery|boda/i, "Transport"],
  [/advert|marketing|promo|flyer|signage/i, "Marketing"],
  [/stationery|cleaning|supplies|packaging/i, "Supplies"],
  [/\bkra\b|\btax\b|levy/i, "Taxes"],
  [/licence|license|permit|council|bank charge|service fee/i, "Fees"]
];

function ruleFor(entry, allowed) {
  const text = `${entry.note || ""}`;
  for (const [pattern, category] of RULES) {
    if (pattern.test(text) && allowed.includes(category)) return category;
  }
  return null;
}

// Returns a Map of transaction id to proposed category. Anything the model
// suggests that is not in `allowed`, or not one of the entries we asked about,
// is discarded — this feeds an UPDATE, so it is checked rather than trusted.
export async function proposeCategories({ entries, allowed, business }) {
  const proposals = new Map();
  if (entries.length === 0) return { proposals, mode: "offline" };

  for (const entry of entries) {
    const guess = ruleFor(entry, allowed);
    if (guess) proposals.set(entry.id, guess);
  }

  if (!aiEnabled()) return { proposals, mode: "offline" };

  const system =
    `You categorise bookkeeping entries for ${business.name}, a small business. ` +
    `Reply with JSON only, in the form {"12": "Rent", "13": "Utilities"} mapping each ` +
    `entry id to exactly one category from this list: ${allowed.join(", ")}. ` +
    `Omit an entry entirely if none of them clearly fits — a wrong category is worse ` +
    `than none. No prose, no explanation, no other keys.`;

  const user = entries
    .map((e) => `id ${e.id}: ${e.kind} ${e.amount} on ${String(e.occurred_on).slice(0, 10)}` +
      `${e.note ? ` — "${e.note}"` : " — no description"}`)
    .join("\n");

  try {
    const text = await callProvider({ system, user, maxTokens: 400, temperature: 0 });
    const json = JSON.parse(text.replace(/^```(?:json)?|```$/gm, "").trim());
    const ids = new Set(entries.map((e) => String(e.id)));

    let accepted = 0;
    for (const [id, category] of Object.entries(json)) {
      // Both halves are checked: an id we did not ask about, or a category
      // outside the list, is dropped rather than written.
      if (!ids.has(String(id)) || !allowed.includes(category)) continue;
      proposals.set(Number(id), category);
      accepted += 1;
    }
    return { proposals, mode: accepted > 0 ? "ai" : "offline" };
  } catch (error) {
    console.warn(`Accountant: categorisation fell back to rules (${error.message})`);
    return { proposals, mode: "offline" };
  }
}
