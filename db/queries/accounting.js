import { pool } from "../index.js";
import { postEntry } from "./ledger.js";
import { billRaisedEntry, invoiceRaisedEntry } from "../../utils/ledger.js";

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

// Raising an invoice is when the money is EARNED, so that is when the ledger
// hears about it: the customer owes us, and revenue is booked. Settling it later
// only turns the debt into cash and books no revenue at all — see payInvoice.
//
// This is the half the old books never recorded. Revenue used to appear only
// when the money arrived, which is why receivables had to be counted by adding
// up unpaid invoices instead of read off an account.
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO invoices
         (business_id, user_id, customer, amount, category, issued_on, due_on, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [businessId, userId, customer, amount, category, issuedOn, dueOn, note]
    );
    const invoice = rows[0];

    await postEntry(client, {
      businessId,
      userId,
      lines: invoiceRaisedEntry({ amount, category, memo: `Invoice: ${customer}` }),
      memo: `Invoice raised: ${customer}`,
      entryDate: issuedOn,
      source: "invoice_raised",
      sourceId: invoice.id
    });

    await client.query("COMMIT");
    return invoice;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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

// The mirror of an invoice: a bill arriving is when the cost is INCURRED (or,
// for stock, when the goods become ours), so the ledger takes it now and the
// payment later only settles the debt.
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO bills
         (business_id, user_id, vendor, amount, category, issued_on, due_on, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [businessId, userId, vendor, amount, category, issuedOn, dueOn, note]
    );
    const bill = rows[0];

    await postEntry(client, {
      businessId,
      userId,
      lines: billRaisedEntry({ amount, category, memo: `Bill: ${vendor}` }),
      memo: `Bill received: ${vendor}`,
      entryDate: issuedOn,
      source: "bill_raised",
      sourceId: bill.id
    });

    await client.query("COMMIT");
    return bill;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
