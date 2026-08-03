import { pool } from "../index.js";

// Storage for the accounting agent. The review itself is computed in
// utils/accounting.js from rows fetched through the existing query modules;
// this only keeps the runs and applies the changes a review proposes.

// Where the monthly close is sent. Null switches notification off.
export async function setReviewEmail(businessId, userId, email) {
  const { rows } = await pool.query(
    `UPDATE businesses SET review_email = $3
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [businessId, userId, email || null]
  );
  return rows[0] || null;
}

export async function recordNotification(reviewId, to) {
  const { rows } = await pool.query(
    `UPDATE accounting_reviews
     SET notified_to = $2, notified_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [reviewId, to]
  );
  return rows[0] || null;
}

export async function setAutoReview(businessId, userId, on) {
  const { rows } = await pool.query(
    `UPDATE businesses SET auto_review = $3
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [businessId, userId, on]
  );
  return rows[0] || null;
}

// Claim this month's automatic review, atomically. The UPDATE only matches if
// the month has not been claimed yet, so whichever request gets there first
// runs the review and every other one is told no. Without this, two page loads
// arriving together would each see "no review yet" and run their own.
//
// Deliberately does NOT catch up on skipped months, unlike recurring
// transactions: each of those is a distinct financial event that really did
// happen, whereas a review is a snapshot of the books as they stand now. Three
// identical reviews for three quiet months would be noise.
export async function claimMonthlyReview(businessId) {
  const { rowCount } = await pool.query(
    `UPDATE businesses
     SET last_auto_review = date_trunc('month', CURRENT_DATE)::date
     WHERE id = $1
       AND auto_review = TRUE
       AND (last_auto_review IS NULL
            OR last_auto_review < date_trunc('month', CURRENT_DATE)::date)`,
    [businessId]
  );
  return rowCount === 1;
}

// Businesses of this user that are opted in and have not been closed this
// month. Used by the entry points that run the review in the background.
export async function businessesDueForReview(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM businesses
     WHERE user_id = $1
       AND auto_review = TRUE
       AND (last_auto_review IS NULL
            OR last_auto_review < date_trunc('month', CURRENT_DATE)::date)`,
    [userId]
  );
  return rows;
}

// Undo a claim so a failed run is retried rather than silently skipped for the
// rest of the month.
export async function releaseMonthlyReview(businessId, previous) {
  await pool.query(
    "UPDATE businesses SET last_auto_review = $2 WHERE id = $1",
    [businessId, previous]
  );
}

export async function saveReview({
  businessId,
  userId,
  counts,
  tax,
  narrative,
  mode,
  findings
}) {
  const { rows } = await pool.query(
    `INSERT INTO accounting_reviews
       (business_id, user_id, findings_total, findings_high, taxable_profit,
        tax_owed, tax_shortfall, narrative, mode, findings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING *`,
    [businessId, userId, counts.total, counts.high, tax.taxableProfit,
     tax.totalOwed, tax.shortfall, narrative, mode, JSON.stringify(findings)]
  );
  return rows[0];
}

export async function listReviews(businessId, userId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT id, findings_total, findings_high, taxable_profit, tax_owed,
            tax_shortfall, mode, notified_to, notified_at, created_at
     FROM accounting_reviews
     WHERE business_id = $1 AND user_id = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [businessId, userId, limit]
  );
  return rows;
}

export async function getReview(id, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM accounting_reviews WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rows[0] || null;
}

// Applying a finding: move an entry to the category the review proposed. Scoped
// by business and user, so a review can only ever touch its own books.
export async function recategoriseTransaction({ id, businessId, userId, category }) {
  const { rows } = await pool.query(
    `UPDATE business_transactions
     SET category = $4
     WHERE id = $1 AND business_id = $2 AND user_id = $3
     RETURNING *`,
    [id, businessId, userId, category]
  );
  return rows[0] || null;
}

// Every entry the review found sitting in a catch-all, with enough context for
// a category to be proposed.
export async function looseEntries(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT id, kind, amount, category, note, occurred_on
     FROM business_transactions
     WHERE business_id = $1 AND user_id = $2
       AND (category IS NULL OR lower(trim(category)) IN ('', 'uncategorized', 'uncategorised', 'other'))
     ORDER BY occurred_on DESC, id DESC`,
    [businessId, userId]
  );
  return rows;
}
