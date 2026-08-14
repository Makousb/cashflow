import { getBusiness } from "../db/queries/business.js";
import { listProducts } from "../db/queries/inventory.js";
import {
  captureContact,
  claimCampaignForSending,
  contactsForFunnels,
  countFunnelView,
  createCampaign,
  createFunnel,
  deleteCampaign,
  deleteFunnel,
  getCampaign,
  getContact,
  getFunnel,
  getLiveFunnelBySlug,
  listCampaigns,
  listContacts,
  listEvents,
  listFunnels,
  markBounced,
  markEmailed,
  purchasingContacts,
  reachableContacts,
  recordCampaignResult,
  recordEvent,
  saveContactNote,
  setContactStage,
  setFunnelStatus,
  unsubscribeByToken
} from "../db/queries/marketing.js";
import { aiEnabled, draftFunnel, draftPromotion } from "../services/marketer.js";
import { mailEnabled, sendMail } from "../services/mailer.js";
import { convert } from "../services/fx.js";
import { config } from "../config/env.js";
import { DEFAULT_CURRENCY } from "../utils/currencies.js";
import { formatCurrency } from "../utils/currency.js";
import { promoEmail } from "../utils/promo-email.js";
import {
  SEGMENTS,
  STAGES,
  STAGE_META,
  audienceFor,
  audiencePreview,
  deriveStage,
  funnelMetrics,
  isSegment,
  portfolio,
  slugify
} from "../utils/marketing.js";
import { today } from "../utils/dates.js";
import { isEmailShaped } from "../utils/validation.js";

function appUrl() {
  return config.appUrl || `http://localhost:${config.port}`;
}

function amountFormatter(user) {
  const display = user?.currency || user?.base_currency || DEFAULT_CURRENCY;
  const base = user?.base_currency || display;
  return (amount) => formatCurrency(convert(amount, base, display), display);
}

async function requireBusiness(req, res) {
  const business = await getBusiness(Number(req.params.id), req.session.user.id);
  if (!business) {
    req.flash("error", "Business not found.");
    res.redirect("/business");
    return null;
  }
  return business;
}

// Stages follow what people actually did, so nobody has to maintain them.
async function refreshStages(business, userId) {
  const [contacts, purchasers] = await Promise.all([
    contactsForFunnels(business.id, userId),
    purchasingContacts(business.id, userId)
  ]);
  const bought = new Map(purchasers.map((p) => [p.id, p.last_purchase_on]));

  for (const contact of contacts) {
    if (contact.status === "unsubscribed") continue;
    const stage = deriveStage(contact, {
      hasPurchased: bought.has(contact.id),
      lastPurchaseOn: bought.get(contact.id),
      today: today()
    });
    if (stage !== contact.stage) {
      await setContactStage(contact.id, userId, stage);
      await recordEvent({
        contactId: contact.id, kind: "stage",
        detail: `Moved from ${contact.stage} to ${stage}`
      });
    }
  }
}

// --- The marketing hub ---

export async function showMarketing(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const userId = req.session.user.id;
    await refreshStages(business, userId);

    const [funnels, contacts, campaigns] = await Promise.all([
      listFunnels(business.id, userId),
      listContacts(business.id, userId),
      listCampaigns(business.id, userId)
    ]);

    const byFunnel = new Map();
    for (const contact of contacts) {
      const key = contact.funnel_id;
      if (!byFunnel.has(key)) byFunnel.set(key, []);
      byFunnel.get(key).push(contact);
    }

    return res.render("marketing", {
      title: `${business.name} · Marketing`,
      business,
      funnels: portfolio(funnels, byFunnel),
      contacts,
      campaigns,
      overall: funnelMetrics({ funnel: { views: funnels.reduce((s, f) => s + f.views, 0) }, contacts }),
      stageMeta: STAGE_META,
      stages: STAGES,
      segments: SEGMENTS,
      live: aiEnabled(),
      mailReady: mailEnabled(),
      publicBase: appUrl()
    });
  } catch (error) {
    return next(error);
  }
}

// --- Funnels ---

export async function generateFunnel(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const user = req.session.user;
  const back = `/business/${business.id}/marketing`;

  try {
    const products = await listProducts(business.id, user.id);
    const draft = await draftFunnel({ business, products, fmt: amountFormatter(user) });

    // Slugs are public URLs and must be unique across every business.
    const suffix = Math.random().toString(36).slice(2, 7);
    const funnel = await createFunnel({
      businessId: business.id,
      userId: user.id,
      name: draft.name,
      slug: slugify(draft.name, suffix),
      headline: draft.headline,
      subhead: draft.subhead,
      offer: draft.offer,
      cta: draft.cta,
      incentive: draft.incentive,
      mode: draft.mode
    });

    req.flash(
      "success",
      `Funnel drafted${draft.mode === "ai" ? "" : " from the built-in copy"}. ` +
        `Read it over, then set it live to start collecting addresses.`
    );
    return res.redirect(`${back}#funnel-${funnel.id}`);
  } catch (error) {
    return next(error);
  }
}

export async function changeFunnelStatus(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const status = ["draft", "live", "paused"].includes(req.body.status) ? req.body.status : null;
  const back = `/business/${business.id}/marketing`;

  if (!status) {
    req.flash("error", "Unknown funnel status.");
    return res.redirect(back);
  }

  try {
    const funnel = await setFunnelStatus(Number(req.params.funnelId), req.session.user.id, status);
    req.flash(
      funnel ? "success" : "error",
      funnel
        ? status === "live"
          ? `“${funnel.name}” is live at ${appUrl()}/f/${funnel.slug}`
          : `“${funnel.name}” is now ${status}.`
        : "Funnel not found."
    );
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

export async function removeFunnel(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    await deleteFunnel(Number(req.params.funnelId), req.session.user.id);
    req.flash("success", "Funnel deleted. The contacts it captured are kept.");
    return res.redirect(`/business/${business.id}/marketing`);
  } catch (error) {
    return next(error);
  }
}

// --- The public capture page (no login) ---

export async function showPublicFunnel(req, res, next) {
  try {
    const funnel = await getLiveFunnelBySlug(req.params.slug);
    if (!funnel) {
      return res.status(404).render("404", { title: "Not found" });
    }
    await countFunnelView(funnel.id);
    return res.render("funnel-public", {
      title: funnel.headline,
      funnel,
      captured: req.query.ok === "1",
      error: req.query.err === "1"
    });
  } catch (error) {
    return next(error);
  }
}

export async function captureLead(req, res, next) {
  try {
    const funnel = await getLiveFunnelBySlug(req.params.slug);
    if (!funnel) {
      return res.status(404).render("404", { title: "Not found" });
    }

    const email = (req.body.email || "").trim().toLowerCase();
    const name = (req.body.name || "").trim().slice(0, 120) || null;
    const consented = req.body.consent === "on" || req.body.consent === "true";

    // No address, no consent, no contact. The tick is not decorative: it is the
    // record that this person agreed to be written to.
    if (!isEmailShaped(email) || !consented) {
      return res.redirect(`/f/${funnel.slug}?err=1`);
    }

    const contact = await captureContact({
      businessId: funnel.business_id,
      userId: funnel.user_id,
      funnelId: funnel.id,
      email,
      name,
      source: `funnel:${funnel.slug}`,
      consentSource: "funnel form"
    });

    if (contact.is_new) {
      await recordEvent({
        contactId: contact.id, kind: "captured",
        detail: `Signed up through “${funnel.name}” and agreed to be emailed`
      });
    }

    return res.redirect(`/f/${funnel.slug}?ok=1`);
  } catch (error) {
    return next(error);
  }
}

// One click, no login, no confirmation step.
export async function unsubscribe(req, res, next) {
  try {
    const contact = await unsubscribeByToken(req.params.token);
    if (!contact) {
      return res.status(404).render("404", { title: "Not found" });
    }
    if (contact.unsubscribed_at) {
      await recordEvent({
        contactId: contact.id, kind: "unsubscribed",
        detail: "Unsubscribed from the link in an email"
      }).catch(() => {});
    }
    return res.render("unsubscribed", { title: "Unsubscribed", email: contact.email });
  } catch (error) {
    return next(error);
  }
}

// --- Contacts ---

export async function showContact(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const contact = await getContact(Number(req.params.contactId), req.session.user.id);
    if (!contact || contact.business_id !== business.id) {
      req.flash("error", "Contact not found.");
      return res.redirect(`/business/${business.id}/marketing`);
    }

    return res.render("contact", {
      title: contact.email,
      business,
      contact,
      events: await listEvents(contact.id),
      stages: STAGES,
      stageMeta: STAGE_META
    });
  } catch (error) {
    return next(error);
  }
}

export async function updateContact(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const userId = req.session.user.id;
  const contactId = Number(req.params.contactId);
  const back = `/business/${business.id}/marketing/contacts/${contactId}`;

  try {
    const contact = await getContact(contactId, userId);
    if (!contact || contact.business_id !== business.id) {
      req.flash("error", "Contact not found.");
      return res.redirect(`/business/${business.id}/marketing`);
    }

    const note = (req.body.notes || "").trim().slice(0, 2000);
    if (note !== (contact.notes || "")) {
      await saveContactNote(contactId, userId, note || null);
      await recordEvent({ contactId, kind: "note", detail: "Note updated" });
    }

    const stage = req.body.stage;
    if (STAGES.includes(stage) && stage !== contact.stage) {
      await setContactStage(contactId, userId, stage);
      await recordEvent({
        contactId, kind: "stage", detail: `Moved to ${stage} by hand`
      });
    }

    req.flash("success", "Contact updated.");
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

// --- Campaigns ---

export async function draftCampaign(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const user = req.session.user;
  const back = `/business/${business.id}/marketing`;
  const segment = isSegment(req.body.segment) ? req.body.segment : "all";

  try {
    const products = await listProducts(business.id, user.id);
    const draft = await draftPromotion({
      business,
      products,
      segmentLabel: SEGMENTS[segment].label,
      fmt: amountFormatter(user)
    });

    const campaign = await createCampaign({
      businessId: business.id,
      userId: user.id,
      name: draft.name,
      subject: draft.subject,
      body: draft.body,
      segment,
      mode: draft.mode
    });

    req.flash(
      "success",
      `Promotion drafted${draft.mode === "ai" ? "" : " from the built-in copy"}. ` +
        `Nothing is sent until you send it.`
    );
    return res.redirect(`${back}#campaign-${campaign.id}`);
  } catch (error) {
    return next(error);
  }
}

export async function editCampaign(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/marketing`;

  try {
    const campaign = await getCampaign(Number(req.params.campaignId), req.session.user.id);
    if (!campaign || campaign.business_id !== business.id) {
      req.flash("error", "Campaign not found.");
      return res.redirect(back);
    }
    if (campaign.status === "sent") {
      req.flash("error", "That promotion has already gone out — it cannot be edited.");
      return res.redirect(back);
    }

    await deleteCampaign(campaign.id, req.session.user.id);
    const segment = isSegment(req.body.segment) ? req.body.segment : campaign.segment;
    const replacement = await createCampaign({
      businessId: business.id,
      userId: req.session.user.id,
      name: (req.body.name || campaign.name).slice(0, 80),
      subject: (req.body.subject || campaign.subject).slice(0, 140),
      body: (req.body.body || campaign.body).slice(0, 4000),
      segment,
      mode: campaign.mode
    });

    req.flash("success", "Promotion updated.");
    return res.redirect(`${back}#campaign-${replacement.id}`);
  } catch (error) {
    return next(error);
  }
}

// Send. Consent is checked three times over: the query only returns subscribed
// rows, audienceFor filters them again, and each message is composed with a
// working unsubscribe link or is not composed at all.
export async function sendCampaign(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const user = req.session.user;
  const back = `/business/${business.id}/marketing`;

  try {
    const campaign = await getCampaign(Number(req.params.campaignId), user.id);
    if (!campaign || campaign.business_id !== business.id) {
      req.flash("error", "Campaign not found.");
      return res.redirect(back);
    }

    if (!mailEnabled()) {
      req.flash("error", "No mail server is configured, so nothing can be sent yet.");
      return res.redirect(back);
    }

    // Claiming flips it to sent, so a second click finds nothing to do.
    const claimed = await claimCampaignForSending(campaign.id, user.id);
    if (!claimed) {
      req.flash("error", "That promotion has already been sent.");
      return res.redirect(back);
    }

    const reachable = await reachableContacts(business.id, user.id);
    const audience = audienceFor(reachable, campaign.segment);
    // Everyone on the list who is not being written to, for any reason —
    // unsubscribed, bounced, or simply outside this segment. Counting only the
    // segment narrowing would report zero skipped on a send that quietly left
    // out every contact who had unsubscribed.
    const onTheList = (await listContacts(business.id, user.id)).length;

    let sent = 0;
    let failed = 0;
    const delivered = [];

    for (const contact of audience) {
      const message = promoEmail({ business, campaign, contact, baseUrl: appUrl() });
      const result = await sendMail({
        to: contact.email,
        subject: message.subject,
        text: message.text,
        html: message.html
      });

      if (result.sent) {
        sent += 1;
        delivered.push(contact.id);
        await recordEvent({
          contactId: contact.id, campaignId: campaign.id, kind: "emailed",
          detail: `Sent “${campaign.subject}”`
        });
      } else {
        failed += 1;
        // A hard bounce takes them out of every future audience.
        if (/mailbox|no such user|does not exist|550/i.test(result.reason || "")) {
          await markBounced(contact.id);
        }
      }
    }

    await markEmailed(delivered);
    await recordCampaignResult(campaign.id, {
      sent, failed, skipped: Math.max(onTheList - audience.length, 0)
    });

    req.flash(
      "success",
      `Sent to ${sent} contact(s)` +
        (failed > 0 ? `, ${failed} could not be delivered` : "") +
        `. Anyone unsubscribed was never included.`
    );
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

export async function previewAudience(req, res, next) {
  try {
    const business = await getBusiness(Number(req.params.id), req.session.user.id);
    if (!business) return res.status(404).json({ error: "Business not found." });

    const contacts = await listContacts(business.id, req.session.user.id);
    return res.json(audiencePreview(contacts, req.query.segment || "all"));
  } catch (error) {
    return next(error);
  }
}

export async function removeCampaign(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    const gone = await deleteCampaign(Number(req.params.campaignId), req.session.user.id);
    req.flash(
      gone ? "success" : "error",
      gone ? "Draft deleted." : "A promotion that has been sent cannot be deleted."
    );
    return res.redirect(`/business/${business.id}/marketing`);
  } catch (error) {
    return next(error);
  }
}
