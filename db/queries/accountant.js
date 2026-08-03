import { pool } from "../index.js";

// Storage for the accounting agent. The review itself is computed in
// utils/accounting.js from rows fetched through the existing query modules;
// this only keeps the runs and applies the changes a review proposes.

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
            tax_shortfall, mode, created_at
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
