// Funnel and CRM arithmetic, as pure functions over the business's own rows.
//
// The important one is audienceFor(). An AI writes the copy in this module's
// sibling service, but it never decides who receives anything — the audience is
// computed here and filtered again in SQL. Someone who has unsubscribed can
// therefore not be reached by a model that hallucinates an address, a segment
// that is spelled wrong, or a caller that forgets to filter.

import { toISODate } from "./dates.js";

// Lifecycle a contact moves through. Order matters: it is the funnel.
export const STAGES = ["lead", "engaged", "customer", "lapsed"];

export const STAGE_META = {
  lead: { label: "Lead", blurb: "Gave you an address, has not bought yet" },
  engaged: { label: "Engaged", blurb: "Has been emailed and is still listening" },
  customer: { label: "Customer", blurb: "Has bought at least once" },
  lapsed: { label: "Lapsed", blurb: "Bought once, then went quiet" }
};

// Who a campaign may go to. Every segment is a subset of the subscribed.
export const SEGMENTS = {
  all: { label: "Everyone subscribed", match: () => true },
  leads: { label: "Leads who have not bought", match: (c) => c.stage === "lead" },
  customers: { label: "Customers", match: (c) => c.stage === "customer" },
  engaged: { label: "Engaged but not yet buying", match: (c) => c.stage === "engaged" },
  lapsed: { label: "Lapsed customers", match: (c) => c.stage === "lapsed" },
  never_emailed: { label: "Never emailed", match: (c) => !c.last_emailed_at }
};

export function isSegment(name) {
  return Object.prototype.hasOwnProperty.call(SEGMENTS, name);
}

// The one function that decides who gets mail.
//
// Consent is checked first and unconditionally, so a bad segment name can only
// ever narrow the audience, never widen it. An unknown segment sends to nobody
// rather than to everybody — the safe direction to fail in.
export function audienceFor(contacts, segment) {
  const consented = contacts.filter(
    (c) => c.status === "subscribed" && Boolean(c.email) && Boolean(c.consent_at)
  );
  if (!isSegment(segment)) return [];
  return consented.filter(SEGMENTS[segment].match);
}

// What the business would be told before it presses send.
export function audiencePreview(contacts, segment) {
  const reachable = audienceFor(contacts, segment);
  const unsubscribed = contacts.filter((c) => c.status === "unsubscribed").length;
  const bounced = contacts.filter((c) => c.status === "bounced").length;

  return {
    segment,
    label: isSegment(segment) ? SEGMENTS[segment].label : "Unknown segment",
    reachable: reachable.length,
    // Named so the UI can say why people are being left out rather than
    // quietly dropping them.
    excludedUnsubscribed: unsubscribed,
    excludedBounced: bounced,
    total: contacts.length,
    valid: isSegment(segment)
  };
}

// Where everyone stands, and how well the funnel converts.
export function funnelMetrics({ funnel, contacts }) {
  const captured = contacts.length;
  const views = Number(funnel?.views || 0);
  const byStage = {};
  for (const stage of STAGES) {
    byStage[stage] = contacts.filter((c) => c.stage === stage).length;
  }

  const customers = byStage.customer + byStage.lapsed;
  const subscribed = contacts.filter((c) => c.status === "subscribed").length;

  return {
    views,
    captured,
    subscribed,
    unsubscribed: contacts.filter((c) => c.status === "unsubscribed").length,
    byStage,
    customers,
    // A visitor who leaves an address.
    captureRate: views > 0 ? (captured / views) * 100 : null,
    // A captured address that goes on to buy.
    conversionRate: captured > 0 ? (customers / captured) * 100 : null,
    // Of those still listening, how many have been written to at all.
    reachRate: subscribed > 0
      ? (contacts.filter((c) => c.status === "subscribed" && c.last_emailed_at).length / subscribed) * 100
      : null
  };
}

// Roll every funnel up for the overview.
export function portfolio(funnels, contactsByFunnel) {
  return funnels
    .map((funnel) => ({
      ...funnel,
      metrics: funnelMetrics({ funnel, contacts: contactsByFunnel.get(funnel.id) || [] })
    }))
    .sort((a, b) => b.metrics.captured - a.metrics.captured);
}

// A contact's stage follows what they have actually done, so the CRM does not
// depend on anyone remembering to move cards around.
export function deriveStage(contact, { hasPurchased, lastPurchaseOn, today, lapseDays = 120 }) {
  if (hasPurchased) {
    const gap = lastPurchaseOn
      ? Math.round(
          (Date.parse(`${toISODate(today)}T00:00:00`) -
            Date.parse(`${toISODate(lastPurchaseOn)}T00:00:00`)) / 86400000
        )
      : 0;
    return gap > lapseDays ? "lapsed" : "customer";
  }
  return contact.last_emailed_at ? "engaged" : "lead";
}

// A slug that is safe in a URL and recognisably from the name it was made from.
export function slugify(name, suffix = "") {
  const base = String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/^-|-$/g, "");
  const stem = base || "offer";
  return suffix ? `${stem}-${suffix}` : stem;
}

// Personalisation, done without pretending to know more than we do.
export function personalise(body, contact) {
  const first = (contact.name || "").trim().split(/\s+/)[0];
  return String(body || "")
    .replaceAll("{{name}}", contact.name || "there")
    .replaceAll("{{first_name}}", first || "there")
    .replaceAll("{{email}}", contact.email || "");
}
