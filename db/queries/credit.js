import { pool } from "../index.js";

// Dates leave here as YYYY-MM-DD strings rather than as Dates, so nothing
// downstream has to remember which of the two it was handed.

export async function listApplications(userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, product, amount, term, purpose, status, reason, fee, apr,
            credit_limit, deposit,
            to_char(decided_on, 'YYYY-MM-DD') AS decided_on
     FROM credit_applications
     WHERE user_id = $1
     ORDER BY id DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

export async function listFacilities(userId) {
  const { rows } = await pool.query(
    `SELECT id, application_id, product, label, principal, fee, apr,
            credit_limit, deposit, status,
            to_char(opened_on, 'YYYY-MM-DD') AS opened_on,
            to_char(due_on, 'YYYY-MM-DD') AS due_on
     FROM credit_facilities
     WHERE user_id = $1
     ORDER BY (status = 'active') DESC, id DESC`,
    [userId]
  );
  return rows;
}

export async function getFacility(id, userId) {
  const { rows } = await pool.query(
    `SELECT id, application_id, product, label, principal, fee, apr,
            credit_limit, deposit, status, transaction_id,
            to_char(opened_on, 'YYYY-MM-DD') AS opened_on,
            to_char(due_on, 'YYYY-MM-DD') AS due_on
     FROM credit_facilities
     WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0] || null;
}

// Every instalment the user has, for working out standings in one pass.
export async function listInstallments(userId) {
  const { rows } = await pool.query(
    `SELECT id, facility_id, sequence, amount,
            to_char(due_on, 'YYYY-MM-DD') AS due_on,
            to_char(paid_on, 'YYYY-MM-DD') AS paid_on,
            transaction_id
     FROM credit_installments
     WHERE user_id = $1
     ORDER BY facility_id, sequence`,
    [userId]
  );
  return rows;
}

export async function getInstallment(id, userId) {
  const { rows } = await pool.query(
    `SELECT id, facility_id, sequence, amount,
            to_char(due_on, 'YYYY-MM-DD') AS due_on,
            to_char(paid_on, 'YYYY-MM-DD') AS paid_on
     FROM credit_installments
     WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0] || null;
}

export async function recordApplication({
  userId, product, amount, term = 0, purpose = null,
  status, reason, fee = 0, apr = 0, creditLimit = null, deposit = null, decidedOn
}) {
  const { rows } = await pool.query(
    `INSERT INTO credit_applications
       (user_id, product, amount, term, purpose, status, reason, fee, apr,
        credit_limit, deposit, decided_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [userId, product, amount, term, purpose, status, reason, fee, apr,
      creditLimit, deposit, decidedOn]
  );
  return rows[0];
}

// An approved application becomes a facility and its schedule together, or not
// at all — a plan with no instalments owes nothing and would never be repaid.
export async function openFacility({
  userId, applicationId, product, label, principal = 0, fee = 0, apr = 0,
  creditLimit = null, deposit = null, openedOn, dueOn = null,
  transactionId = null, schedule = []
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO credit_facilities
         (user_id, application_id, product, label, principal, fee, apr,
          credit_limit, deposit, opened_on, due_on, transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [userId, applicationId, product, label, principal, fee, apr,
        creditLimit, deposit, openedOn, dueOn, transactionId]
    );
    const facility = rows[0];

    for (const row of schedule) {
      await client.query(
        `INSERT INTO credit_installments
           (facility_id, user_id, sequence, due_on, amount)
         VALUES ($1, $2, $3, $4, $5)`,
        [facility.id, userId, row.sequence, row.dueOn, row.amount]
      );
    }

    await client.query("COMMIT");
    return facility;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Marks one instalment paid and settles the facility if that was the last of
// them, so a facility is never left active with nothing outstanding.
export async function settleInstallment({ installmentId, userId, paidOn, transactionId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: paid } = await client.query(
      `UPDATE credit_installments
       SET paid_on = $3, transaction_id = $4
       WHERE id = $1 AND user_id = $2 AND paid_on IS NULL
       RETURNING facility_id`,
      [installmentId, userId, paidOn, transactionId]
    );

    if (paid.length === 0) {
      await client.query("ROLLBACK");
      return { updated: false, settled: false };
    }

    const facilityId = paid[0].facility_id;
    const { rows: left } = await client.query(
      "SELECT COUNT(*)::int AS remaining FROM credit_installments WHERE facility_id = $1 AND paid_on IS NULL",
      [facilityId]
    );

    const settled = left[0].remaining === 0;
    if (settled) {
      await client.query(
        "UPDATE credit_facilities SET status = 'settled', closed_at = NOW() WHERE id = $1",
        [facilityId]
      );
    }

    await client.query("COMMIT");
    return { updated: true, settled, facilityId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listCharges(userId) {
  const { rows } = await pool.query(
    `SELECT id, facility_id, merchant, amount,
            to_char(charged_on, 'YYYY-MM-DD') AS charged_on
     FROM credit_charges
     WHERE user_id = $1
     ORDER BY charged_on DESC, id DESC`,
    [userId]
  );
  return rows;
}

export async function listCardPayments(userId) {
  const { rows } = await pool.query(
    `SELECT id, facility_id, amount,
            to_char(paid_on, 'YYYY-MM-DD') AS paid_on, transaction_id
     FROM credit_payments
     WHERE user_id = $1
     ORDER BY paid_on DESC, id DESC`,
    [userId]
  );
  return rows;
}

export async function addCharge({ facilityId, userId, merchant, amount, chargedOn }) {
  const { rows } = await pool.query(
    `INSERT INTO credit_charges (facility_id, user_id, merchant, amount, charged_on)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [facilityId, userId, merchant, amount, chargedOn]
  );
  return rows[0];
}

export async function addCardPayment({ facilityId, userId, amount, paidOn, transactionId = null }) {
  const { rows } = await pool.query(
    `INSERT INTO credit_payments (facility_id, user_id, amount, paid_on, transaction_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [facilityId, userId, amount, paidOn, transactionId]
  );
  return rows[0];
}

// Take the right to tell someone about one missed statement. Exactly one caller
// gets it: the unique key on (facility, cycle) settles a race in the database
// rather than in whichever request happened to read first.
export async function claimCardNotice({ facilityId, userId, cycle, sentTo }) {
  const { rowCount } = await pool.query(
    `INSERT INTO credit_notices (facility_id, user_id, cycle, sent_to)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (facility_id, cycle) DO NOTHING`,
    [facilityId, userId, cycle, sentTo]
  );
  return rowCount === 1;
}

// Hand the claim back when the mail did not go, so the next visit tries again.
export async function releaseCardNotice({ facilityId, cycle }) {
  await pool.query(
    "DELETE FROM credit_notices WHERE facility_id = $1 AND cycle = $2",
    [facilityId, cycle]
  );
}

export async function listCardNotices(userId) {
  const { rows } = await pool.query(
    `SELECT facility_id, cycle, sent_to, sent_at
     FROM credit_notices
     WHERE user_id = $1`,
    [userId]
  );
  return rows;
}

export async function closeFacility(id, userId) {
  const { rows } = await pool.query(
    `UPDATE credit_facilities
     SET status = 'closed', closed_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'active'
     RETURNING *`,
    [id, userId]
  );
  return rows[0] || null;
}

// The figures every decision is made from, straight out of the ledger: what a
// month typically brings in and takes out, averaged over the months given.
export async function monthlyMeans(userId, months = 3) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0)::float / $2 AS monthly_income,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::float / $2 AS monthly_expenses
     FROM transactions
     WHERE user_id = $1
       AND occurred_on >= date_trunc('month', CURRENT_DATE)
                          -- Cast: $2 is divided above, which fixes it as a
                          -- float, and make_interval will not take one.
                          - make_interval(months => ($2 - 1)::int)`,
    [userId, months]
  );
  return rows[0];
}

// What is already promised each month: existing loan minimums, plus a month's
// worth of everything live here.
export async function monthlyCommitments(userId) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COALESCE(SUM(minimum_payment), 0)::float FROM loans WHERE user_id = $1)
       +
       (SELECT COALESCE(SUM(i.amount), 0)::float
        FROM credit_installments i
        JOIN credit_facilities f ON f.id = i.facility_id
        WHERE i.user_id = $1 AND i.paid_on IS NULL AND f.status = 'active'
          AND i.due_on < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')
       AS monthly_commitments`,
    [userId]
  );
  return Number(rows[0].monthly_commitments);
}

// Totals the assessments need: whether one of a product is already running, and
// how much is riding on plans.
export async function creditExposure(userId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE product = 'day_loan' AND status = 'active')::int AS active_day_loans,
       COUNT(*) FILTER (WHERE product = 'secured_card' AND status = 'active')::int AS active_cards,
       COALESCE(SUM(principal) FILTER (WHERE product = 'bnpl' AND status = 'active'), 0)::float
         AS outstanding_plans
     FROM credit_facilities
     WHERE user_id = $1`,
    [userId]
  );
  return rows[0];
}
