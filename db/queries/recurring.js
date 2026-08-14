import { pool } from "../index.js";
import { ownedAccountId, ownedCategoryId } from "./transactions.js";

export async function listRecurring(userId) {
  const { rows } = await pool.query(
    `SELECT r.*,
            to_char(r.next_run, 'YYYY-MM-DD') AS next_run_iso,
            c.name AS category_name,
            c.icon AS category_icon,
            a.name AS account_name
     FROM recurring_transactions r
     LEFT JOIN categories c ON c.id = r.category_id
     LEFT JOIN accounts a ON a.id = r.account_id
     WHERE r.user_id = $1
     ORDER BY r.active DESC, r.next_run`,
    [userId]
  );
  return rows;
}

// The wallet and category are checked here as well as in createTransaction,
// because a rule is stored now and spent later: an id that is not the owner's
// would otherwise sit in the table until it came due, and then fail on a page
// load rather than on the form that set it.
export async function createRecurring({
  userId,
  accountId,
  categoryId,
  kind,
  amount,
  note,
  frequency,
  nextRun
}) {
  const account = await ownedAccountId(pool, accountId, userId);
  const category = await ownedCategoryId(pool, categoryId, userId);

  const { rows } = await pool.query(
    `INSERT INTO recurring_transactions
       (user_id, account_id, category_id, kind, amount, note, frequency, next_run)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [userId, account, category, kind, amount, note, frequency, nextRun]
  );
  return rows[0];
}

// Active rules whose next occurrence is on or before `today` (ISO date).
export async function getDueRecurring(userId, today) {
  const { rows } = await pool.query(
    `SELECT id, account_id, category_id, kind, amount, note, frequency,
            to_char(next_run, 'YYYY-MM-DD') AS next_run_iso
     FROM recurring_transactions
     WHERE user_id = $1 AND active = TRUE AND next_run <= $2`,
    [userId, today]
  );
  return rows;
}

export async function setRecurringNextRun(id, userId, nextRun) {
  await pool.query(
    "UPDATE recurring_transactions SET next_run = $1 WHERE id = $2 AND user_id = $3",
    [nextRun, id, userId]
  );
}

export async function setRecurringActive(id, userId, active) {
  await pool.query(
    "UPDATE recurring_transactions SET active = $1 WHERE id = $2 AND user_id = $3",
    [active, id, userId]
  );
}

export async function deleteRecurring(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM recurring_transactions WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}
