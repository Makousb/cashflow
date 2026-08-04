import crypto from "node:crypto";

import { pool } from "../index.js";

// Funnels, contacts and campaigns.
//
// Consent is enforced here as well as in utils/marketing.js. That duplication is
// deliberate: audienceFor() decides the segment, and this layer refuses to hand
// back anyone unsubscribed no matter what it is asked for. A promotion would
// have to get past both to reach someone who has left.

const token = () => crypto.randomBytes(24).toString("base64url");

// --- Funnels ---

export async function createFunnel({
  businessId, userId, name, slug, headline, subhead, offer, cta, incentive, mode
}) {
  const { rows } = await pool.query(
    `INSERT INTO funnels
       (business_id, user_id, name, slug, headline, subhead, offer, cta, incentive, mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [businessId, userId, name, slug, headline, subhead, offer, cta, incentive, mode || "offline"]
  );
  return rows[0];
}

export async function listFunnels(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM funnels
     WHERE business_id = $1 AND user_id = $2
     ORDER BY created_at DESC`,
    [businessId, userId]
  );
  return rows;
}

export async function getFunnel(id, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM funnels WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rows[0] || null;
}

// Public lookup: only a live funnel is reachable, and no user scope applies
// because the visitor is not signed in.
export async function getLiveFunnelBySlug(slug) {
  const { rows } = await pool.query(
    `SELECT f.*, b.name AS business_name
     FROM funnels f
     JOIN businesses b ON b.id = f.business_id
     WHERE f.slug = $1 AND f.status = 'live'`,
    [slug]
  );
  return rows[0] || null;
}

export async function setFunnelStatus(id, userId, status) {
  const { rows } = await pool.query(
    `UPDATE funnels SET status = $3
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [id, userId, status]
  );
  return rows[0] || null;
}

export async function countFunnelView(id) {
  await pool.query("UPDATE funnels SET views = views + 1 WHERE id = $1", [id]);
}

export async function deleteFunnel(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM funnels WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}

// --- Contacts ---

// Capture an address. Signing up again is not an error and not a duplicate: it
// refreshes the name and the consent record.
//
// It deliberately does NOT resubscribe someone who has left. Re-entering an
// address must not undo an unsubscribe, or the unsubscribe means nothing.
export async function captureContact({
  businessId, userId, funnelId, email, name, source, consentSource
}) {
  const { rows } = await pool.query(
    `INSERT INTO contacts
       (business_id, user_id, funnel_id, email, name, source, consent_source, unsubscribe_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (business_id, lower(email)) DO UPDATE
     SET name = COALESCE(EXCLUDED.name, contacts.name),
         funnel_id = COALESCE(contacts.funnel_id, EXCLUDED.funnel_id),
         consent_at = CASE
           WHEN contacts.status = 'subscribed' THEN NOW() ELSE contacts.consent_at
         END
     RETURNING *, (xmax = 0) AS is_new`,
    [businessId, userId, funnelId, email, name, source, consentSource || "funnel", token()]
  );
  return rows[0];
}

export async function listContacts(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT c.*, f.name AS funnel_name
     FROM contacts c
     LEFT JOIN funnels f ON f.id = c.funnel_id
     WHERE c.business_id = $1 AND c.user_id = $2
     ORDER BY c.created_at DESC`,
    [businessId, userId]
  );
  return rows;
}

export async function getContact(id, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM contacts WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rows[0] || null;
}

// The only rows a campaign may ever load. The status filter is not optional and
// not a parameter — there is no way to call this and get someone who has left.
export async function reachableContacts(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM contacts
     WHERE business_id = $1 AND user_id = $2
       AND status = 'subscribed'
       AND consent_at IS NOT NULL
     ORDER BY created_at`,
    [businessId, userId]
  );
  return rows;
}

export async function contactsForFunnels(businessId, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM contacts WHERE business_id = $1 AND user_id = $2",
    [businessId, userId]
  );
  return rows;
}

// Leaving, from the link in the email. No login, no business involvement, and
// it works on the first click.
export async function unsubscribeByToken(unsubscribeToken) {
  const { rows } = await pool.query(
    `UPDATE contacts
     SET status = 'unsubscribed', unsubscribed_at = NOW()
     WHERE unsubscribe_token = $1 AND status <> 'unsubscribed'
     RETURNING *`,
    [unsubscribeToken]
  );
  if (rows[0]) return rows[0];

  // Already gone: report success rather than an error, so a second click on an
  // old email does not look like a failure to leave.
  const { rows: existing } = await pool.query(
    "SELECT * FROM contacts WHERE unsubscribe_token = $1",
    [unsubscribeToken]
  );
  return existing[0] || null;
}

export async function setContactStage(id, userId, stage) {
  const { rows } = await pool.query(
    `UPDATE contacts SET stage = $3 WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, stage]
  );
  return rows[0] || null;
}

export async function saveContactNote(id, userId, notes) {
  const { rows } = await pool.query(
    `UPDATE contacts SET notes = $3 WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, notes]
  );
  return rows[0] || null;
}

export async function markEmailed(ids) {
  if (ids.length === 0) return;
  await pool.query(
    "UPDATE contacts SET last_emailed_at = NOW() WHERE id = ANY($1::int[])",
    [ids]
  );
}

export async function markBounced(id) {
  const { rows } = await pool.query(
    "UPDATE contacts SET status = 'bounced' WHERE id = $1 AND status = 'subscribed' RETURNING *",
    [id]
  );
  return rows[0] || null;
}

// Contacts the business has actually sold to. This is what promotes a lead to
// a customer without anyone filing paperwork.
//
// A sale records its customer as free text, so the match is on the address if
// one was typed and otherwise on the name. Matching names is not watertight —
// two customers can share one — but the alternative is a CRM where almost
// nobody ever becomes a customer, since a shop counter rarely captures an
// email at the till. The stage is a hint the owner can override by hand.
export async function purchasingContacts(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT c.id, MAX(s.occurred_on) AS last_purchase_on
     FROM contacts c
     JOIN sales s ON s.business_id = c.business_id
                 AND s.customer IS NOT NULL
                 AND (lower(s.customer) = lower(c.email)
                      OR (c.name IS NOT NULL AND lower(s.customer) = lower(c.name)))
     WHERE c.business_id = $1 AND c.user_id = $2
     GROUP BY c.id`,
    [businessId, userId]
  );
  return rows;
}

// --- The relationship timeline ---

export async function recordEvent({ contactId, campaignId, kind, detail }) {
  const { rows } = await pool.query(
    `INSERT INTO contact_events (contact_id, campaign_id, kind, detail)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [contactId, campaignId || null, kind, detail]
  );
  return rows[0];
}

export async function listEvents(contactId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT e.*, c.name AS campaign_name
     FROM contact_events e
     LEFT JOIN campaigns c ON c.id = e.campaign_id
     WHERE e.contact_id = $1
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT $2`,
    [contactId, limit]
  );
  return rows;
}

// --- Campaigns ---

export async function createCampaign({
  businessId, userId, name, subject, body, segment, mode
}) {
  const { rows } = await pool.query(
    `INSERT INTO campaigns (business_id, user_id, name, subject, body, segment, mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [businessId, userId, name, subject, body, segment, mode || "offline"]
  );
  return rows[0];
}

export async function listCampaigns(businessId, userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT * FROM campaigns
     WHERE business_id = $1 AND user_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [businessId, userId, limit]
  );
  return rows;
}

export async function getCampaign(id, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM campaigns WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rows[0] || null;
}

// Only ever from draft, so a campaign cannot be sent to the same list twice by
// double-clicking or by two tabs.
export async function claimCampaignForSending(id, userId) {
  const { rows } = await pool.query(
    `UPDATE campaigns SET status = 'sent', sent_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'draft'
     RETURNING *`,
    [id, userId]
  );
  return rows[0] || null;
}

export async function recordCampaignResult(id, { sent, failed, skipped }) {
  const { rows } = await pool.query(
    `UPDATE campaigns
     SET sent_count = $2, failed_count = $3, skipped_count = $4
     WHERE id = $1
     RETURNING *`,
    [id, sent, failed, skipped]
  );
  return rows[0] || null;
}

export async function deleteCampaign(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM campaigns WHERE id = $1 AND user_id = $2 AND status = 'draft'",
    [id, userId]
  );
  return rowCount > 0;
}
