import { pool } from "../index.js";

export async function updateTaxRate(businessId, userId, rate) {
  await pool.query(
    "UPDATE businesses SET income_tax_rate = $1 WHERE id = $2 AND user_id = $3",
    [rate, businessId, userId]
  );
}

// Total payroll deductions withheld across all pay runs — money held on
// employees' behalf that must be remitted to the tax authority.
export async function payrollDeductionsTotal(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(deduction_total), 0) AS total
     FROM pay_runs WHERE business_id = $1 AND user_id = $2`,
    [businessId, userId]
  );
  return Number(rows[0].total);
}

export async function listProvisions(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_provisions
     WHERE business_id = $1 AND user_id = $2
     ORDER BY set_on DESC, id DESC`,
    [businessId, userId]
  );
  return rows;
}

export async function addProvision({ businessId, userId, amount, note, setOn }) {
  const { rows } = await pool.query(
    `INSERT INTO tax_provisions (business_id, user_id, amount, note, set_on)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [businessId, userId, amount, note, setOn]
  );
  return rows[0];
}

export async function deleteProvision(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM tax_provisions WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}
