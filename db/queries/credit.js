import { pool } from "../index.js";
import { NOT_EARNINGS } from "../../utils/credit.js";

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
export async function claimCardNotice({ facilityId, userId, cycle, kind = "missed", sentTo }) {
  const { rowCount } = await pool.query(
    `INSERT INTO credit_notices (facility_id, user_id, cycle, kind, sent_to)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (facility_id, cycle, kind) DO NOTHING`,
    [facilityId, userId, cycle, kind, sentTo]
  );
  return rowCount === 1;
}

// Hand the claim back when the mail did not go, so the next visit tries again.
export async function releaseCardNotice({ facilityId, cycle, kind = "missed" }) {
  await pool.query(
    "DELETE FROM credit_notices WHERE facility_id = $1 AND cycle = $2 AND kind = $3",
    [facilityId, cycle, kind]
  );
}

export async function listCardNotices(userId) {
  const { rows } = await pool.query(
    `SELECT facility_id, cycle, kind, sent_to, sent_at
     FROM credit_notices
     WHERE user_id = $1
     ORDER BY id`,
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

// What was opened during a year, by product — the borrowing side of the annual
// report. Years are bounded by make_date rather than by extracting the year
// from the column, so the index on the date can still be used.
export async function creditOpenedInYear(userId, year) {
  const { rows } = await pool.query(
    `SELECT product,
            COUNT(*)::int AS count,
            COALESCE(SUM(principal), 0)::float AS principal,
            COALESCE(SUM(fee), 0)::float AS fee,
            COALESCE(SUM(credit_limit), 0)::float AS credit_limit
     FROM credit_facilities
     WHERE user_id = $1
       AND opened_on >= make_date($2, 1, 1)
       AND opened_on < make_date($2 + 1, 1, 1)
     GROUP BY product
     ORDER BY principal DESC`,
    [userId, year]
  );
  return rows;
}

// Where a year's money went, biggest category first.
//
// Repayments and card deposits are left out, for the same reason they are left
// out of the purchases below and so that the two halves of the page agree:
// settling a card is not spending on a category, it is paying for spending that
// already happened and was already counted where it happened. Left in, anyone
// who cleared a card would be told their biggest category of the year was
// paying off the card.
export async function spendingByCategoryInYear(userId, year) {
  const { rows } = await pool.query(
    `SELECT COALESCE(c.name, 'Uncategorized') AS name,
            COALESCE(c.icon, '🧾') AS icon,
            SUM(t.amount)::float AS total,
            COUNT(*)::int AS count
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.user_id = $1
       AND t.kind = 'expense'
       AND t.occurred_on >= make_date($2, 1, 1)
       AND t.occurred_on < make_date($2 + 1, 1, 1)
       AND (t.note IS NULL
            OR (t.note NOT LIKE 'Card payment —%'
                AND t.note NOT LIKE 'Credit repayment:%'
                AND t.note NOT LIKE 'Loan payment:%'
                AND t.note NOT LIKE 'Secured card deposit%'))
     GROUP BY 1, 2
     ORDER BY total DESC`,
    [userId, year]
  );
  return rows;
}

// The year's biggest purchases, from both sides of how one can be made: money
// out of a wallet, and anything put on the card.
//
// Repayments are left out on purpose. Paying a card or an instalment moves money
// but buys nothing — it settles what an earlier purchase already bought, and
// counting it here would list the same spending twice under a duller name.
export async function biggestPurchasesInYear(userId, year, limit = 10) {
  const { rows } = await pool.query(
    `(SELECT to_char(t.occurred_on, 'YYYY-MM-DD') AS spent_on,
             COALESCE(NULLIF(t.note, ''), 'Expense') AS what,
             COALESCE(c.name, 'Uncategorized') AS category,
             t.amount::float AS amount,
             'wallet' AS source
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.user_id = $1
        AND t.kind = 'expense'
        AND t.occurred_on >= make_date($2, 1, 1)
        AND t.occurred_on < make_date($2 + 1, 1, 1)
        AND (t.note IS NULL
             OR (t.note NOT LIKE 'Card payment —%'
                 AND t.note NOT LIKE 'Credit repayment:%'
                 AND t.note NOT LIKE 'Loan payment:%'
                 -- Nor is a card deposit a purchase. It leaves the wallet and
                 -- comes back when the card closes; it buys nothing on the way.
                 AND t.note NOT LIKE 'Secured card deposit%')))
     UNION ALL
     (SELECT to_char(ch.charged_on, 'YYYY-MM-DD'),
             ch.merchant,
             'On the card',
             ch.amount::float,
             'card'
      FROM credit_charges ch
      WHERE ch.user_id = $1
        AND ch.charged_on >= make_date($2, 1, 1)
        AND ch.charged_on < make_date($2 + 1, 1, 1))
     ORDER BY amount DESC, spent_on DESC
     LIMIT $3`,
    [userId, year, limit]
  );
  return rows;
}

// Which years there is anything to report on, newest first.
export async function yearsWithActivity(userId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT year FROM (
       SELECT EXTRACT(YEAR FROM occurred_on)::int AS year
         FROM transactions WHERE user_id = $1
       UNION
       SELECT EXTRACT(YEAR FROM opened_on)::int
         FROM credit_facilities WHERE user_id = $1
     ) years
     ORDER BY year DESC`,
    [userId]
  );
  return rows.map((r) => r.year);
}

// The figures every decision is made from, straight out of the ledger: what a
// month typically brings in and takes out, averaged over the months given.
export async function monthlyMeans(userId, months = 3) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (
         WHERE kind = 'income'
           -- Borrowed money arriving is not money earned. Left in, a drawdown
           -- raises the income this is averaging, and the income is what caps
           -- the next loan — so borrowing would buy the room to borrow again.
           AND (note IS NULL OR note NOT LIKE ALL($3::text[]))
       ), 0)::float / $2 AS monthly_income,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::float / $2 AS monthly_expenses
     FROM transactions
     WHERE user_id = $1
       AND occurred_on >= date_trunc('month', CURRENT_DATE)
                          -- Cast: $2 is divided above, which fixes it as a
                          -- float, and make_interval will not take one.
                          - make_interval(months => ($2 - 1)::int)`,
    [userId, months, NOT_EARNINGS]
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
