import { pool } from "../index.js";

export async function listBudgets(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM business_budgets
     WHERE business_id = $1 AND user_id = $2
     ORDER BY kind, category`,
    [businessId, userId]
  );
  return rows;
}

export async function upsertBudget({ businessId, userId, kind, category, amount }) {
  const { rows } = await pool.query(
    `INSERT INTO business_budgets (business_id, user_id, kind, category, amount)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id, kind, category)
     DO UPDATE SET amount = EXCLUDED.amount
     RETURNING *`,
    [businessId, userId, kind, category, amount]
  );
  return rows[0];
}

export async function deleteBudget(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM business_budgets WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}

// This month's income total and expense totals by category.
export async function monthlyActuals(businessId, userId, monthStart) {
  const income = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS revenue
     FROM business_transactions
     WHERE business_id = $1 AND user_id = $2 AND kind = 'income'
       AND occurred_on >= $3 AND occurred_on < $3::date + INTERVAL '1 month'`,
    [businessId, userId, monthStart]
  );

  const byCategory = await pool.query(
    `SELECT category, SUM(amount) AS total
     FROM business_transactions
     WHERE business_id = $1 AND user_id = $2 AND kind = 'expense'
       AND occurred_on >= $3 AND occurred_on < $3::date + INTERVAL '1 month'
     GROUP BY category`,
    [businessId, userId, monthStart]
  );

  const expenses = {};
  for (const row of byCategory.rows) {
    expenses[row.category] = Number(row.total);
  }

  return { revenue: Number(income.rows[0].revenue), expenses };
}
