// Telling somebody a lender has asked to see their credit history.
//
// The one thing this email must not do is lend the asker credibility it has no
// way to check. "Equity Bank" is whatever was typed into a form by whoever had
// the code, and nothing here has verified it. So the name is reported as a
// claim rather than stated as a fact, and the email says plainly that agreeing
// is a decision to make with somebody already known to be asking — not because
// a message arrived saying so.
//
// Pure. Takes the ask, gives back a subject and two bodies.

import { formatDate } from "./dates.js";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function requestReceivedEmail({ request, purpose, fmt, url }) {
  const lender = request.lender || "Someone";
  const what = (purpose?.label || "borrowing").toLowerCase();

  const subject = `${lender} is asking to see your credit history`;

  const text = [
    `Someone using the name "${lender}" has asked to see your credit history`,
    `for ${what}${request.amount_sought ? ` of ${fmt(request.amount_sought)}` : ""}.`,
    request.reference ? `Their reference: ${request.reference}` : null,
    `Asked on ${formatDate(request.requested_at)}.`,
    "",
    "They have been shown nothing. Nothing is shared unless you approve it, and",
    "turning it down shows them nothing but the fact that you did.",
    "",
    "Cashflow has not checked who they are — that name is what they typed after",
    "somebody gave them your code. Approve it because you are already dealing",
    "with them, not because this email arrived.",
    "",
    `Answer it here: ${url}`
  ].filter((line) => line !== null).join("\n");

  const html = `
    <div style="font-family: system-ui, sans-serif; max-width: 34rem; line-height: 1.5;">
      <p>Someone using the name <strong>${esc(lender)}</strong> has asked to see your
         credit history for ${esc(what)}${
           request.amount_sought ? ` of ${esc(fmt(request.amount_sought))}` : ""
         }.</p>
      ${request.reference ? `<p>Their reference: ${esc(request.reference)}</p>` : ""}
      <p>Asked on ${esc(formatDate(request.requested_at))}.</p>
      <p><strong>They have been shown nothing.</strong> Nothing is shared unless you
         approve it, and turning it down shows them nothing but the fact that you did.</p>
      <p>Cashflow has not checked who they are — that name is what they typed after
         somebody gave them your code. Approve it because you are already dealing with
         them, not because this email arrived.</p>
      <p><a href="${esc(url)}">Answer it here</a></p>
    </div>
  `.trim();

  return { subject, text, html };
}
