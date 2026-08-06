// Turns a missed card statement into an email. Pure — it takes the statement
// and gives back a subject and two bodies, so what gets sent can be read and
// tested without a mail server anywhere near it.
//
// The tone is deliberate. This is somebody's own money going wrong, and the
// email exists to be useful at the moment it lands: what was owed, when it was
// owed, what it costs to leave it, and where to go. No urgency it has not
// earned, and nothing about consequences that do not exist here — missing a
// minimum in this app charges no fee and tells nobody else.

import { formatDate } from "./dates.js";

// The card's label is whatever the holder typed, so it is escaped before it
// goes anywhere near the HTML body.
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 1st, 2nd, 3rd, 4th — and 11th through 13th, which break the pattern the
// last digit would otherwise give.
function ordinal(n) {
  const teens = n % 100;
  if (teens >= 11 && teens <= 13) return `${n}th`;
  const last = n % 10;
  if (last === 1) return `${n}st`;
  if (last === 2) return `${n}nd`;
  if (last === 3) return `${n}rd`;
  return `${n}th`;
}

// Before the date, not after it. The difference from the missed notice is the
// whole point: nothing has gone wrong yet, so this says what is coming and how
// to be done with it, and nothing about consequences.
export function minimumDueSoonEmail({ facility, statement, standing, fmt, url }) {
  const label = facility.label || "your card";
  const due = formatDate(statement.dueOn);
  const outstanding = statement.minimumDue > statement.paidTowards
    ? statement.minimumDue - statement.paidTowards
    : 0;

  const subject = `${fmt(outstanding)} due on ${label} by ${due}`;

  const text = [
    `The minimum payment on ${label} is due on ${due}.`,
    "",
    `Statement drawn ${formatDate(statement.closedOn)}: ${fmt(statement.balance)}`,
    `Minimum to pay: ${fmt(statement.minimumDue)}`,
    statement.paidTowards > 0
      ? `Already paid: ${fmt(statement.paidTowards)} — ${fmt(outstanding)} to go`
      : null,
    "",
    `Clearing the whole ${fmt(standing.balance)} stops the interest;`,
    `paying the minimum keeps the card straight and costs`,
    `${fmt(standing.monthlyInterest)} next month on what is left.`,
    "",
    `Pay it here: ${url}`
  ].filter((line) => line !== null).join("\n");

  const html = `
    <div style="font-family: system-ui, sans-serif; max-width: 34rem; line-height: 1.5;">
      <p>The minimum payment on <strong>${esc(label)}</strong> is due on ${esc(due)}.</p>
      <table cellpadding="6" style="border-collapse: collapse; margin: 1rem 0;">
        <tr><td>Statement drawn ${esc(formatDate(statement.closedOn))}</td>
            <td align="right"><strong>${esc(fmt(statement.balance))}</strong></td></tr>
        <tr><td>Minimum to pay</td>
            <td align="right"><strong>${esc(fmt(statement.minimumDue))}</strong></td></tr>
        ${
          statement.paidTowards > 0
            ? `<tr><td>Already paid</td><td align="right">${esc(fmt(statement.paidTowards))} — ${esc(fmt(outstanding))} to go</td></tr>`
            : ""
        }
      </table>
      <p>Clearing the whole <strong>${esc(fmt(standing.balance))}</strong> stops the interest;
         paying the minimum keeps the card straight and costs
         ${esc(fmt(standing.monthlyInterest))} next month on what is left.</p>
      <p><a href="${esc(url)}">Pay it here</a></p>
    </div>
  `.trim();

  return { subject, text, html };
}

export function missedMinimumEmail({ facility, statement, standing, fmt, url }) {
  const label = facility.label || "your card";
  const due = formatDate(statement.dueOn);
  const drawn = formatDate(statement.closedOn);

  const subject = `Minimum payment missed on ${label} — was due ${due}`;

  const outstanding = standing.minimumDue > statement.paidTowards
    ? standing.minimumDue - statement.paidTowards
    : 0;

  const lines = [
    `The minimum payment on ${label} was due on ${due} and has not been met.`,
    "",
    `Statement drawn ${drawn}: ${fmt(statement.balance)}`,
    `Minimum asked for: ${fmt(statement.minimumDue)}`,
    statement.paidTowards > 0
      ? `Paid towards it: ${fmt(statement.paidTowards)} — ${fmt(outstanding)} short`
      : "Paid towards it: nothing",
    "",
    `The balance now stands at ${fmt(standing.balance)}, and carrying it costs`,
    `${fmt(standing.monthlyInterest)} in interest next month. There is no late fee.`,
    standing.missedCount > 1
      ? `\nThis is the ${ordinal(standing.missedCount)} statement in a row to go unpaid.`
      : "",
    "",
    `Pay it here: ${url}`
  ];

  const text = lines.filter((line) => line !== undefined).join("\n");

  const html = `
    <div style="font-family: system-ui, sans-serif; max-width: 34rem; line-height: 1.5;">
      <p>The minimum payment on <strong>${esc(label)}</strong> was due on
         ${esc(due)} and has not been met.</p>
      <table cellpadding="6" style="border-collapse: collapse; margin: 1rem 0;">
        <tr><td>Statement drawn ${esc(drawn)}</td>
            <td align="right"><strong>${esc(fmt(statement.balance))}</strong></td></tr>
        <tr><td>Minimum asked for</td>
            <td align="right"><strong>${esc(fmt(statement.minimumDue))}</strong></td></tr>
        <tr><td>Paid towards it</td>
            <td align="right">${
              statement.paidTowards > 0
                ? `${esc(fmt(statement.paidTowards))} — ${esc(fmt(outstanding))} short`
                : "nothing"
            }</td></tr>
      </table>
      <p>The balance now stands at <strong>${esc(fmt(standing.balance))}</strong>, and
         carrying it costs ${esc(fmt(standing.monthlyInterest))} in interest next month.
         There is no late fee.</p>
      ${
        standing.missedCount > 1
          ? `<p>This is the ${ordinal(standing.missedCount)} statement in a row to go unpaid.</p>`
          : ""
      }
      <p><a href="${esc(url)}">Pay it here</a></p>
    </div>
  `.trim();

  return { subject, text, html };
}
