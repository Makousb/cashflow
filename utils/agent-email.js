// The card agent's briefing, as an email. Pure — it takes a run and gives back
// a subject and two bodies, so what gets sent can be read and tested without a
// mail server anywhere near it.
//
// This lands in somebody's inbox unasked, so it earns its place or it should not
// be sent: what the agent did while they were not looking, then what is left for
// them to do, and nothing else. No urgency it has not earned, and every figure
// is one they can check against the page it links to.

import { formatDate } from "./dates.js";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// What the subject line leads with, in the order somebody would want to hear it:
// money that moved, then money at risk, then nothing much.
function subjectFor(review, actions, fmt) {
  const paid = actions.filter((a) => a.kind === "paid");
  if (paid.length > 0) {
    const total = paid.reduce((sum, a) => sum + Number(a.amount), 0);
    return paid.length === 1
      ? `Paid ${fmt(total)} on ${paid[0].label}`
      : `Paid ${fmt(total)} across ${paid.length} cards`;
  }

  const urgent = review.moves.find((m) => m.severity === "high");
  if (urgent) return urgent.title;

  return review.counts.total > 0
    ? `${review.counts.total} thing${review.counts.total === 1 ? "" : "s"} worth doing on your cards`
    : "Your cards are in good order";
}

export function briefingEmail({ review, actions = [], narrative, fmt, url, when = new Date() }) {
  const subject = subjectFor(review, actions, fmt);
  const shown = review.moves.slice(0, 6);

  const text = [
    `Card agent · ${formatDate(when)}`,
    "",
    narrative,
    "",
    ...(actions.length
      ? ["WHAT I DID:", ...actions.map((a) => `  ${a.detail}`), ""]
      : []),
    ...(shown.length
      ? ["WHAT IS LEFT:", ...shown.map((m) => `  [${m.severity}] ${m.title}\n    ${m.detail}`), ""]
      : ["Nothing needs doing.", ""]),
    `Owing ${fmt(review.balance)} of ${fmt(review.limit)} — ${review.utilisation}% of your limits in use.`,
    `Points banked: ${review.points.balance} (worth ${fmt(review.points.worth)}).`,
    "",
    `See it all here: ${url}`
  ].join("\n");

  const html = `
    <div style="font-family: system-ui, sans-serif; max-width: 36rem; line-height: 1.5;">
      <p style="color:#666;margin:0 0 1rem;">Card agent · ${esc(formatDate(when))}</p>
      <p>${esc(narrative)}</p>
      ${
        actions.length
          ? `<h3 style="margin:1.5rem 0 0.5rem;">What I did</h3>
             <ul>${actions.map((a) => `<li>${esc(a.detail)}</li>`).join("")}</ul>`
          : ""
      }
      ${
        shown.length
          ? `<h3 style="margin:1.5rem 0 0.5rem;">What is left</h3>
             <ul>${shown
               .map(
                 (m) =>
                   `<li><strong>${esc(m.title)}</strong><br />` +
                   `<span style="color:#555;">${esc(m.detail)}</span></li>`
               )
               .join("")}</ul>`
          : "<p>Nothing needs doing.</p>"
      }
      <table cellpadding="6" style="border-collapse: collapse; margin: 1rem 0;">
        <tr><td>Owing</td>
            <td align="right"><strong>${esc(fmt(review.balance))}</strong> of
              ${esc(fmt(review.limit))} (${review.utilisation}%)</td></tr>
        <tr><td>Points banked</td>
            <td align="right"><strong>${review.points.balance}</strong> —
              worth ${esc(fmt(review.points.worth))}</td></tr>
      </table>
      <p><a href="${esc(url)}">Open the agent</a></p>
    </div>
  `.trim();

  return { subject, text, html };
}
