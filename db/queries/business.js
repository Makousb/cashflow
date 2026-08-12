import { pool } from "../index.js";
import { ensureChart, postEntry } from "./ledger.js";
import { cashMovementEntry } from "../../utils/ledger.js";

export async function listBusinesses(userId) {
  const { rows } = await pool.query(
    `SELECT b.*,
            COALESCE(SUM(t.amount) FILTER (WHERE t.kind = 'income'), 0) AS revenue,
            COALESCE(SUM(t.amount) FILTER (WHERE t.kind = 'expense'), 0) AS expenses
     FROM businesses b
     LEFT JOIN business_transactions t ON t.business_id = b.id
     WHERE b.user_id = $1
     GROUP BY b.id
     ORDER BY b.created_at`,
    [userId]
  );
  return rows;
}

export async function getBusiness(id, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM businesses WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rows[0] || null;
}

// The share code is stamped on here rather than left to the boot-time backfill,
// which would otherwise leave a business uncontactable — and invisible to the
// supply chain's connect-by-code — until the next restart.
export async function createBusiness({ userId, name, industry }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: created } = await client.query(
      `INSERT INTO businesses (user_id, name, industry)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [userId, name, industry]
    );

    // The code is derived from the row's id, so it takes a second statement:
    // Postgres gives every part of one statement the same snapshot, which means
    // a data-modifying CTE cannot see the row it just inserted. Both run in one
    // transaction so a business is never left without a code.
    const { rows } = await client.query(
      `UPDATE businesses
       SET supply_code = 'CF-' || upper(substr(md5('cashflow-supply-' || id::text), 1, 6))
       WHERE id = $1
       RETURNING *`,
      [created[0].id]
    );

    // A business opens its books with a chart of accounts, in the same
    // transaction that creates it. Anything else leaves a window in which it can
    // trade but cannot post, and the first sale would fail on a missing account.
    await ensureChart(created[0].id, userId, client);

    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteBusiness(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM businesses WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}

// Every module that moves a business's money comes through here — an invoice
// being settled, a bill paid, stock received, a pay run, a plain bookkeeping
// entry. So this is where the journal is written too, in the same transaction:
// one place instead of a posting bolted onto five controllers, none of which
// could be relied on to remember.
//
// A caller already inside a transaction passes its client, so the row and its
// journal live or die together with whatever else that caller is doing.
export async function addBusinessTransaction({
  businessId,
  userId,
  kind,
  amount,
  category,
  note,
  occurredOn,
  client = null,
  // The far side of the entry, when it is not cash. Settling an invoice takes
  // money in but earns nothing — the earning happened when the invoice was
  // raised — so those callers say so rather than letting revenue be booked
  // twice. Null means the ordinary case: the category decides.
  entry = null
}) {
  const own = client === null;
  const db = client || await pool.connect();

  try {
    if (own) await db.query("BEGIN");

    const { rows } = await db.query(
      `INSERT INTO business_transactions
         (business_id, user_id, kind, amount, category, note, occurred_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [businessId, userId, kind, amount, category, note, occurredOn]
    );
    const transaction = rows[0];

    await postEntry(db, {
      businessId,
      userId,
      lines: entry || cashMovementEntry({ kind, category, amount, memo: note }),
      memo: note,
      entryDate: occurredOn,
      source: "bookkeeping",
      sourceId: transaction.id
    });

    if (own) await db.query("COMMIT");
    return transaction;
  } catch (error) {
    if (own) await db.query("ROLLBACK");
    throw error;
  } finally {
    if (own) db.release();
  }
}

export async function listBusinessTransactions(businessId, userId, limit = 100) {
  const { rows } = await pool.query(
    `SELECT * FROM business_transactions
     WHERE business_id = $1 AND user_id = $2
     ORDER BY occurred_on DESC, id DESC
     LIMIT $3`,
    [businessId, userId, limit]
  );
  return rows;
}

export async function deleteBusinessTransaction(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM business_transactions WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}

// Profit & loss: totals plus an expense breakdown by category.
export async function businessPnL(businessId, userId) {
  const totals = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0) AS revenue,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0) AS expenses
     FROM business_transactions
     WHERE business_id = $1 AND user_id = $2`,
    [businessId, userId]
  );

  const byCategory = await pool.query(
    `SELECT category,
            SUM(amount) AS total
     FROM business_transactions
     WHERE business_id = $1 AND user_id = $2 AND kind = 'expense'
     GROUP BY category
     ORDER BY total DESC`,
    [businessId, userId]
  );

  const revenue = Number(totals.rows[0].revenue);
  const expenses = Number(totals.rows[0].expenses);

  return {
    revenue,
    expenses,
    net: revenue - expenses,
    margin: revenue > 0 ? ((revenue - expenses) / revenue) * 100 : 0,
    byCategory: byCategory.rows
  };
}

// Revenue, expenses and net per month over the last `months`, chronological.
export async function monthlyTrend(businessId, userId, months = 6) {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', occurred_on), 'YYYY-MM') AS month,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0) AS revenue,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0) AS expenses
     FROM business_transactions
     WHERE business_id = $1 AND user_id = $2
       AND occurred_on >= date_trunc('month', CURRENT_DATE)
                          - make_interval(months => $3 - 1)
     GROUP BY 1
     ORDER BY 1`,
    [businessId, userId, months]
  );
  return rows.map((r) => ({
    month: r.month,
    revenue: Number(r.revenue),
    expenses: Number(r.expenses),
    net: Number(r.revenue) - Number(r.expenses)
  }));
}
