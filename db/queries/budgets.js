import { pool } from "../index.js";
import { ownedCategoryId } from "./transactions.js";

// Each budget row is joined with what was actually spent in that category
// during its month, so views can render progress bars directly.
export async function listBudgetsWithSpend(userId, monthStart) {
  const { rows } = await pool.query(
    `SELECT b.*,
            c.name AS category_name,
            c.icon AS category_icon,
            COALESCE((
              SELECT SUM(t.amount)
              FROM transactions t
              WHERE t.user_id = b.user_id
                AND t.category_id = b.category_id
                AND t.kind = 'expense'
                AND t.occurred_on >= b.month
                AND t.occurred_on < b.month + INTERVAL '1 month'
            ), 0) AS spent
     FROM budgets b
     JOIN categories c ON c.id = b.category_id
     WHERE b.user_id = $1 AND b.month = $2
     ORDER BY c.name`,
    [userId, monthStart]
  );
  return rows;
}

// Spending with no category at all cannot join to a budget row and so never
// shows up above — not "on track", just invisible. This is what the budgets
// page uses to say so, rather than the gap being silent.
export async function uncategorizedSpend(userId, monthStart) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS spent, COUNT(*)::int AS count
     FROM transactions
     WHERE user_id = $1
       AND category_id IS NULL
       AND kind = 'expense'
       AND occurred_on >= $2
       AND occurred_on < $2::date + INTERVAL '1 month'`,
    [userId, monthStart]
  );
  return rows[0];
}

// Checked like a transaction's category: a budget joins to categories to show
// the name, so an id belonging to somebody else would print their private
// category on this page.
export async function upsertBudget({ userId, categoryId, month, amount }) {
  await ownedCategoryId(pool, categoryId, userId);

  const { rows } = await pool.query(
    `INSERT INTO budgets (user_id, category_id, month, amount)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, category_id, month)
     DO UPDATE SET amount = EXCLUDED.amount
     RETURNING *`,
    [userId, categoryId, month, amount]
  );
  return rows[0];
}
