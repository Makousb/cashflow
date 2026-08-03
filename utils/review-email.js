// Turns a finished review into an email. Pure — it takes the review and gives
// back a subject and two bodies, so what gets sent can be tested without a mail
// server anywhere near it.

const SEVERITY_COLOUR = { high: "#b3261e", medium: "#8a6100", low: "#1b7a43" };

// Findings quote vendor names, categories and notes the owner typed, so every
// one of them is escaped before it goes anywhere near the HTML body.
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function monthName(date) {
  return new Date(date).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function reviewEmail({ business, tax, review, narrative, fmt, url, when }) {
  const month = monthName(when || new Date());
  const high = review.counts.high;

  const subject = review.clean
    ? `${business.name}: books closed for ${month} — nothing to fix`
    : `${business.name}: ${review.counts.total} finding${review.counts.total === 1 ? "" : "s"}` +
      `${high > 0 ? ` (${high} needing attention)` : ""} — ${month}`;

  const figures = [
    ["Taxable profit", fmt(tax.taxableProfit)],
    ["Tax owed", fmt(tax.totalOwed)],
    ["Set aside", fmt(tax.setAside)],
    ["Still to find", fmt(tax.shortfall)]
  ];

  const text = [
    `${business.name} — monthly close, ${month}`,
    "",
    narrative,
    "",
    "THE NUMBERS",
    ...figures.map(([label, value]) => `  ${label}: ${value}`),
    "",
    review.findings.length ? "WHAT IT FOUND" : "Nothing to correct.",
    ...review.findings.map((f) => `  [${f.severity}] ${f.title}\n    ${f.detail}`),
    "",
    url ? `Open the review: ${url}` : "",
    "",
    "These are working estimates for planning, computed from your own books.",
    "They are not a filing or a substitute for an accountant signing your return."
  ]
    .filter((line) => line !== null && line !== undefined)
    .join("\n");

  const rows = figures
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 14px 6px 0;color:#6b6152;">${esc(label)}</td>` +
        `<td style="padding:6px 0;font-weight:700;color:#211d14;">${esc(value)}</td></tr>`
    )
    .join("");

  const findings = review.findings
    .map(
      (f) =>
        `<li style="margin-bottom:14px;padding-left:12px;border-left:3px solid ${
          SEVERITY_COLOUR[f.severity] || SEVERITY_COLOUR.low
        };">` +
        `<div style="font-weight:700;color:#211d14;">${esc(f.title)}</div>` +
        `<div style="color:#6b6152;font-size:14px;">${esc(f.detail)}</div></li>`
    )
    .join("");

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:620px;margin:0 auto;padding:24px;color:#211d14;background:#faf8f2;">
  <div style="display:inline-block;padding:6px 12px;border-radius:10px;background:#f5be27;color:#33200a;font-weight:800;">Cashflow</div>
  <h1 style="font-size:20px;margin:18px 0 4px;">${esc(business.name)} — monthly close</h1>
  <p style="margin:0 0 18px;color:#6b6152;">${esc(month)}</p>

  <p style="background:#fef8e6;border:1px solid #fdedc2;border-radius:10px;padding:14px 16px;line-height:1.6;margin:0 0 18px;">${esc(narrative)}</p>

  <table style="border-collapse:collapse;margin-bottom:18px;">${rows}</table>

  ${
    review.findings.length
      ? `<h2 style="font-size:16px;margin:0 0 10px;">What it found</h2><ul style="list-style:none;padding:0;margin:0 0 18px;">${findings}</ul>`
      : `<p style="margin:0 0 18px;">Nothing to correct — the books are clean.</p>`
  }

  ${
    url
      ? `<p style="margin:0 0 18px;"><a href="${esc(url)}" style="display:inline-block;background:#f5be27;color:#33200a;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:10px;">Open the review</a></p>`
      : ""
  }

  <p style="color:#6b6152;font-size:12px;line-height:1.5;margin:0;">
    Every figure here is computed from your own books. These are working
    estimates for planning — not a filing, and not a substitute for an
    accountant signing your return.
  </p>
</div>`;

  return { subject, text, html };
}
