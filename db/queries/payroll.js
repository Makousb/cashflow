import { pool } from "../index.js";

export async function listEmployees(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM employees
     WHERE business_id = $1 AND user_id = $2
     ORDER BY active DESC, name`,
    [businessId, userId]
  );
  return rows;
}

export async function createEmployee({
  businessId,
  userId,
  name,
  role,
  payType,
  payRate,
  hours,
  deductionRate
}) {
  const { rows } = await pool.query(
    `INSERT INTO employees
       (business_id, user_id, name, role, pay_type, pay_rate, hours, deduction_rate)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [businessId, userId, name, role, payType, payRate, hours, deductionRate]
  );
  return rows[0];
}

export async function deleteEmployee(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM employees WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}

// Create a pay run with its payslips and link it to the ledger expense, all in
// one transaction. `payslips` is [{ employeeId, name, gross, deductions, net }].
export async function createPayRun({
  businessId,
  userId,
  transactionId,
  period,
  runOn,
  payslips
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const totals = payslips.reduce(
      (acc, p) => {
        acc.gross += p.gross;
        acc.deductions += p.deductions;
        acc.net += p.net;
        return acc;
      },
      { gross: 0, deductions: 0, net: 0 }
    );

    const { rows } = await client.query(
      `INSERT INTO pay_runs
         (business_id, user_id, transaction_id, period, gross_total,
          deduction_total, net_total, employee_count, run_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        businessId, userId, transactionId, period,
        totals.gross, totals.deductions, totals.net, payslips.length, runOn
      ]
    );
    const run = rows[0];

    for (const p of payslips) {
      await client.query(
        `INSERT INTO payslips (pay_run_id, employee_id, name, gross, deductions, net)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [run.id, p.employeeId, p.name, p.gross, p.deductions, p.net]
      );
    }

    await client.query("COMMIT");
    return run;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listPayRuns(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM pay_runs
     WHERE business_id = $1 AND user_id = $2
     ORDER BY created_at DESC`,
    [businessId, userId]
  );
  return rows;
}

export async function listPayslips(payRunId) {
  const { rows } = await pool.query(
    "SELECT * FROM payslips WHERE pay_run_id = $1 ORDER BY name",
    [payRunId]
  );
  return rows;
}

// Delete a pay run, its payslips (cascade), and the ledger expense it posted.
export async function deletePayRun(id, userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "DELETE FROM pay_runs WHERE id = $1 AND user_id = $2 RETURNING transaction_id",
      [id, userId]
    );
    const removed = rows[0];

    if (removed && removed.transaction_id) {
      await client.query(
        "DELETE FROM business_transactions WHERE id = $1 AND user_id = $2",
        [removed.transaction_id, userId]
      );
    }

    await client.query("COMMIT");
    return Boolean(removed);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
