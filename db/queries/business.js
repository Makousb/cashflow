import { pool } from "../index.js";

export async function listBusinesses(userId) {
  const { rows } = await pool.query(
    `SELECT b.*,
            COALESCE(SUM(t.amount) FILTER (WHERE t.kind = 'income'), 0) AS revenue,
            COALESCE(SUM(t.amount) FILTER (WHERE t.kind = 'expense'), 0) AS expenses
     FROM businesses b
     LEFT JOIN business_transactions t ON t.business_id = b.id
     WHERE b.user_id = $1
     GROUP BY b.id
     ORDER BY b.created_at`,
    [userId]
  );
  return rows;
}

export async function getBusiness(id, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM businesses WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rows[0] || null;
}

// The share code is stamped on here rather than left to the boot-time backfill,
// which would otherwise leave a business uncontactable — and invisible to the
// supply chain's connect-by-code — until the next restart.
export async function createBusiness({ userId, name, industry }) {
  const { rows } = await pool.query(
    `WITH created AS (
       INSERT INTO businesses (user_id, name, industry)
       VALUES ($1, $2, $3)
       RETURNING id
     )
     UPDATE businesses b
     SET supply_code = 'MT-' || upper(substr(md5('moneytree-supply-' || b.id::text), 1, 6))
     FROM created
     WHERE b.id = created.id
     RETURNING b.*`,
    [userId, name, industry]
  );
  return rows[0];
}

export async function deleteBusiness(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM businesses WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}

export async function addBusinessTransaction({
  businessId,
  userId,
  kind,
  amount,
  category,
  note,
  occurredOn
}) {
  const { rows } = await pool.query(
    `INSERT INTO business_transactions
       (business_id, user_id, kind, amount, category, note, occurred_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [businessId, userId, kind, amount, category, note, occurredOn]
  );
  return rows[0];
}

export async function listBusinessTransactions(businessId, userId, limit = 100) {
  const { rows } = await pool.query(
    `SELECT * FROM business_transactions
     WHERE business_id = $1 AND user_id = $2
     ORDER BY occurred_on DESC, id DESC
     LIMIT $3`,
    [businessId, userId, limit]
  );
  return rows;
}

export async function deleteBusinessTransaction(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM business_transactions WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}

// Profit & loss: totals plus an expense breakdown by category.
export async function businessPnL(businessId, userId) {
  const totals = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0) AS revenue,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0) AS expenses
     FROM business_transactions
     WHERE business_id = $1 AND user_id = $2`,
    [businessId, userId]
  );

  const byCategory = await pool.query(
    `SELECT category,
            SUM(amount) AS total
     FROM business_transactions
     WHERE business_id = $1 AND user_id = $2 AND kind = 'expense'
     GROUP BY category
     ORDER BY total DESC`,
    [businessId, userId]
  );

  const revenue = Number(totals.rows[0].revenue);
  const expenses = Number(totals.rows[0].expenses);

  return {
    revenue,
    expenses,
    net: revenue - expenses,
    margin: revenue > 0 ? ((revenue - expenses) / revenue) * 100 : 0,
    byCategory: byCategory.rows
  };
}

// Revenue, expenses and net per month over the last `months`, chronological.
export async function monthlyTrend(businessId, userId, months = 6) {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', occurred_on), 'YYYY-MM') AS month,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0) AS revenue,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0) AS expenses
     FROM business_transactions
     WHERE business_id = $1 AND user_id = $2
       AND occurred_on >= date_trunc('month', CURRENT_DATE)
                          - make_interval(months => $3 - 1)
     GROUP BY 1
     ORDER BY 1`,
    [businessId, userId, months]
  );
  return rows.map((r) => ({
    month: r.month,
    revenue: Number(r.revenue),
    expenses: Number(r.expenses),
    net: Number(r.revenue) - Number(r.expenses)
  }));
}
