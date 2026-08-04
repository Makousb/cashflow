// Builds one promotional email for one contact.
//
// The unsubscribe link is not a parameter and not a flag. Every message this
// function produces carries a working one-click link in both bodies, because a
// promotion someone cannot leave is not a promotion, it is spam — and because
// the alternative is relying on whoever calls this to remember.

import { personalise } from "./marketing.js";

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function unsubscribeUrl(baseUrl, contact) {
  return `${String(baseUrl || "").replace(/\/$/, "")}/unsubscribe/${contact.unsubscribe_token}`;
}

export function promoEmail({ business, campaign, contact, baseUrl }) {
  if (!contact?.unsubscribe_token) {
    // Refusing outright rather than sending something nobody can leave.
    throw new Error("cannot compose a promotion without an unsubscribe token");
  }

  const leave = unsubscribeUrl(baseUrl, contact);
  const body = personalise(campaign.body, contact);
  const subject = personalise(campaign.subject, contact);

  const text = [
    body,
    "",
    "—",
    `You are receiving this because you gave ${business.name} your email address.`,
    `To stop receiving these, unsubscribe here: ${leave}`
  ].join("\n");

  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.6;">${esc(p).replace(/\n/g, "<br />")}</p>`)
    .join("");

  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#211d14;background:#faf8f2;">
  <div style="display:inline-block;padding:6px 12px;border-radius:10px;background:#f5be27;color:#33200a;font-weight:800;margin-bottom:18px;">${esc(business.name)}</div>
  ${paragraphs}
  <hr style="border:none;border-top:1px solid #ece6d6;margin:24px 0 14px;" />
  <p style="color:#6b6152;font-size:12px;line-height:1.6;margin:0;">
    You are receiving this because you gave ${esc(business.name)} your email address.<br />
    <a href="${esc(leave)}" style="color:#a06908;">Unsubscribe</a> — one click, no questions.
  </p>
</div>`;

  return { subject, text, html, unsubscribeUrl: leave };
}
