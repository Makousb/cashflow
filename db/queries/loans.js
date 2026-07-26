import { pool } from "../index.js";

export async function listLoans(userId) {
  const { rows } = await pool.query(
    "SELECT * FROM loans WHERE user_id = $1 ORDER BY created_at",
    [userId]
  );
  return rows;
}

export async function getLoan(id, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM loans WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rows[0] || null;
}

export async function createLoan({
  userId,
  name,
  lender,
  principal,
  apr,
  minimumPayment,
  startDate
}) {
  const { rows } = await pool.query(
    `INSERT INTO loans (user_id, name, lender, principal, apr, minimum_payment, start_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [userId, name, lender, principal, apr, minimumPayment, startDate]
  );
  return rows[0];
}

export async function deleteLoan(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM loans WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}

// All of a user's loan payments (used to compute per-loan metrics in one pass).
export async function listLoanPayments(userId) {
  const { rows } = await pool.query(
    `SELECT id, loan_id, amount,
            to_char(paid_on, 'YYYY-MM-DD') AS paid_on, note
     FROM loan_payments
     WHERE user_id = $1
     ORDER BY paid_on`,
    [userId]
  );
  return rows;
}

export async function addLoanPayment({
  loanId,
  userId,
  amount,
  paidOn,
  note,
  transactionId = null
}) {
  const { rows } = await pool.query(
    `INSERT INTO loan_payments (loan_id, user_id, amount, paid_on, note, transaction_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [loanId, userId, amount, paidOn, note, transactionId]
  );
  return rows[0];
}

// Average monthly spend per expense category over the last `months`, with the
// current month's budget (if any). Powers the payoff plan's "what to cut".
export async function monthlySpendByCategory(userId, months = 3) {
  const { rows } = await pool.query(
    `SELECT c.name,
            c.icon,
            COALESCE(SUM(t.amount), 0)::float / $2 AS monthly_avg,
            (SELECT b.amount::float
             FROM budgets b
             WHERE b.user_id = $1 AND b.category_id = c.id
               AND b.month = date_trunc('month', CURRENT_DATE)) AS budget
     FROM categories c
     LEFT JOIN transactions t
       ON t.category_id = c.id AND t.user_id = $1 AND t.kind = 'expense'
       AND t.occurred_on >= date_trunc('month', CURRENT_DATE)
                            - make_interval(months => $2 - 1)
     WHERE (c.user_id IS NULL OR c.user_id = $1) AND c.kind = 'expense'
     GROUP BY c.id, c.name, c.icon
     HAVING COALESCE(SUM(t.amount), 0) > 0
     ORDER BY monthly_avg DESC`,
    [userId, months]
  );
  return rows;
}
