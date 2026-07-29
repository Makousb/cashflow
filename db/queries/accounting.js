import { pool } from "../index.js";

// --- Accounts receivable (invoices) ---

export async function listInvoices(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM invoices
     WHERE business_id = $1 AND user_id = $2
     ORDER BY status, COALESCE(due_on, issued_on), id DESC`,
    [businessId, userId]
  );
  return rows;
}

export async function getInvoice(id, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM invoices WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rows[0] || null;
}

export async function createInvoice({
  businessId,
  userId,
  customer,
  amount,
  category,
  issuedOn,
  dueOn,
  note
}) {
  const { rows } = await pool.query(
    `INSERT INTO invoices
       (business_id, user_id, customer, amount, category, issued_on, due_on, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [businessId, userId, customer, amount, category, issuedOn, dueOn, note]
  );
  return rows[0];
}

export async function markInvoicePaid(id, userId, paidOn, transactionId) {
  const { rows } = await pool.query(
    `UPDATE invoices
     SET status = 'paid', paid_on = $3, transaction_id = $4
     WHERE id = $1 AND user_id = $2 AND status = 'unpaid'
     RETURNING *`,
    [id, userId, paidOn, transactionId]
  );
  return rows[0] || null;
}

export async function deleteInvoice(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM invoices WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}

// --- Accounts payable (bills) ---

export async function listBills(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM bills
     WHERE business_id = $1 AND user_id = $2
     ORDER BY status, COALESCE(due_on, issued_on), id DESC`,
    [businessId, userId]
  );
  return rows;
}

export async function getBill(id, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM bills WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rows[0] || null;
}

export async function createBill({
  businessId,
  userId,
  vendor,
  amount,
  category,
  issuedOn,
  dueOn,
  note
}) {
  const { rows } = await pool.query(
    `INSERT INTO bills
       (business_id, user_id, vendor, amount, category, issued_on, due_on, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [businessId, userId, vendor, amount, category, issuedOn, dueOn, note]
  );
  return rows[0];
}

export async function markBillPaid(id, userId, paidOn, transactionId) {
  const { rows } = await pool.query(
    `UPDATE bills
     SET status = 'paid', paid_on = $3, transaction_id = $4
     WHERE id = $1 AND user_id = $2 AND status = 'unpaid'
     RETURNING *`,
    [id, userId, paidOn, transactionId]
  );
  return rows[0] || null;
}

export async function deleteBill(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM bills WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}

// --- Totals for the balance sheet ---

// Outstanding (unpaid) receivables and payables.
export async function outstandingTotals(businessId, userId) {
  const ar = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM invoices WHERE business_id = $1 AND user_id = $2 AND status = 'unpaid'`,
    [businessId, userId]
  );
  const ap = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM bills WHERE business_id = $1 AND user_id = $2 AND status = 'unpaid'`,
    [businessId, userId]
  );
  return {
    receivable: Number(ar.rows[0].total),
    payable: Number(ap.rows[0].total)
  };
}
