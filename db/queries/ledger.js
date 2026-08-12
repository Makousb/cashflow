import { pool } from "../index.js";
import { STANDARD_CHART, cashMovementEntry, checkEntry } from "../../utils/ledger.js";

// The only way anything gets into the general ledger.
//
// Every posting goes through postEntry, which refuses an entry that does not
// balance before a single row is written. That refusal is the reason a trial
// balance means anything: there is no path into journal_lines that skips it,
// and the CHECK in the schema catches even a hand-written INSERT.
//
// Most callers are already inside a transaction of their own — a sale moves
// stock, books revenue and posts a journal, and either all of it happens or none
// of it does. So postEntry takes a client rather than opening its own.

// Give a business the chart it starts with. Idempotent: only missing accounts
// are inserted, so it is safe to call on every boot and on every business, and
// an owner who renamed "Rent" keeps their name.
export async function ensureChart(businessId, userId, client = pool) {
  let added = 0;
  for (const account of STANDARD_CHART) {
    const { rowCount } = await client.query(
      `INSERT INTO ledger_accounts (business_id, user_id, key, code, name, type)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [businessId, userId, account.key, account.code, account.name, account.type]
    );
    added += rowCount;
  }
  return added;
}

// Every business that has no chart yet gets one. Runs at boot so books that
// existed before the ledger did are ready to post the moment anything happens.
export async function ensureAllCharts() {
  const { rows } = await pool.query(
    `SELECT b.id, b.user_id
     FROM businesses b
     WHERE NOT EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.business_id = b.id)`
  );
  let charted = 0;
  for (const business of rows) {
    await ensureChart(business.id, business.user_id);
    charted += 1;
  }
  return charted;
}

export async function listAccounts(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT id, key, code, name, type, active
     FROM ledger_accounts
     WHERE business_id = $1 AND user_id = $2
     ORDER BY code`,
    [businessId, userId]
  );
  return rows;
}

// key → id, for resolving what the pure builders name into what the rows need.
async function accountIds(businessId, client = pool) {
  const { rows } = await client.query(
    "SELECT id, key, code FROM ledger_accounts WHERE business_id = $1",
    [businessId]
  );
  const byKey = new Map();
  const byCode = new Map();
  for (const row of rows) {
    if (row.key) byKey.set(row.key, row.id);
    byCode.set(row.code, row.id);
  }
  return { byKey, byCode };
}

// Write one entry. Returns the entry row, or null when this exact source event
// has already been posted — which is not a failure. A retried request, a
// double-clicked button and a backfill re-run all land here, and posting a sale
// twice would be far worse than posting it once.
export async function postEntry(client, {
  businessId, userId, lines, memo = null, entryDate, source = "manual", sourceId = null
}) {
  const verdict = checkEntry(lines);
  if (!verdict.ok) {
    // Thrown rather than returned: an unbalanced entry is a bug in the caller,
    // not a condition to handle, and it must take the surrounding transaction
    // down with it rather than leaving half a movement recorded.
    throw new Error(`Refusing to post an unbalanced entry: ${verdict.reason}`);
  }

  let { byKey } = await accountIds(businessId, client);

  // A business can be created by routes this file has never heard of — the seed
  // script and the test fixtures both insert one with raw SQL. Rather than
  // requiring every one of them to remember to open a chart, a missing account
  // opens it here and looks again. Costs an extra query only in the case that
  // would otherwise have been an error, and makes "a business that cannot post"
  // a state that does not exist.
  if (lines.some((line) => !byKey.get(line.account))) {
    await ensureChart(businessId, userId, client);
    ({ byKey } = await accountIds(businessId, client));
  }

  const resolved = lines.map((line) => {
    const id = byKey.get(line.account);
    if (!id) throw new Error(`No ledger account "${line.account}" on business ${businessId}.`);
    return { ...line, accountId: id };
  });

  const { rows: entries } = await client.query(
    `INSERT INTO journal_entries (business_id, user_id, entry_no, entry_date, memo, source, source_id)
     VALUES ($1, $2,
             (SELECT COALESCE(MAX(entry_no), 0) + 1 FROM journal_entries WHERE business_id = $1),
             COALESCE($3::date, CURRENT_DATE), $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [businessId, userId, entryDate || null, memo, source, sourceId]
  );

  // The partial unique index on (business, source, source_id) took the hit.
  if (entries.length === 0) return null;
  const entry = entries[0];

  for (const line of resolved) {
    await client.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit, memo)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.id, line.accountId, line.debit || 0, line.credit || 0, line.memo || null]
    );
  }

  return entry;
}

// For callers with no transaction of their own to join.
export async function postEntryAlone(options) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const entry = await postEntry(client, options);
    await client.query("COMMIT");
    return entry;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Every line of the ledger, for the trial balance and the statements built on
// it. Flat rather than grouped: utils/ledger.js does the arithmetic, and it can
// only do that on rows it has all of.
export async function ledgerLines(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT l.account_id, l.debit::float, l.credit::float
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     WHERE e.business_id = $1 AND e.user_id = $2`,
    [businessId, userId]
  );
  return rows;
}

export async function listEntries(businessId, userId, limit = 100) {
  const { rows } = await pool.query(
    `SELECT e.id, e.entry_no, e.memo, e.source, e.source_id,
            to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date,
            COALESCE(SUM(l.debit), 0)::float AS total,
            COUNT(l.id)::int AS line_count
     FROM journal_entries e
     LEFT JOIN journal_lines l ON l.entry_id = e.id
     WHERE e.business_id = $1 AND e.user_id = $2
     GROUP BY e.id
     ORDER BY e.entry_date DESC, e.entry_no DESC
     LIMIT $3`,
    [businessId, userId, limit]
  );
  return rows;
}

export async function getEntry(id, businessId, userId) {
  const { rows: entries } = await pool.query(
    `SELECT id, entry_no, memo, source, source_id,
            to_char(entry_date, 'YYYY-MM-DD') AS entry_date
     FROM journal_entries
     WHERE id = $1 AND business_id = $2 AND user_id = $3`,
    [id, businessId, userId]
  );
  if (entries.length === 0) return null;

  const { rows: lines } = await pool.query(
    `SELECT l.debit::float, l.credit::float, l.memo,
            a.code, a.name, a.type
     FROM journal_lines l
     JOIN ledger_accounts a ON a.id = l.account_id
     WHERE l.entry_id = $1
     ORDER BY l.debit DESC, l.id`,
    [id]
  );
  return { ...entries[0], lines };
}

// An account the owner adds themselves. No key — that is what marks it as
// theirs rather than one the code posts to by name.
export async function createAccount({ businessId, userId, code, name, type }) {
  const { rows } = await pool.query(
    `INSERT INTO ledger_accounts (business_id, user_id, key, code, name, type)
     VALUES ($1, $2, NULL, $3, $4, $5)
     ON CONFLICT (business_id, code) DO NOTHING
     RETURNING *`,
    [businessId, userId, code, name, type]
  );
  return rows[0] || null;
}

// Which source events already have a posting, so the backfill can skip them
// without asking one row at a time.
export async function postedSourceIds(businessId, source) {
  const { rows } = await pool.query(
    `SELECT source_id FROM journal_entries
     WHERE business_id = $1 AND source = $2 AND source_id IS NOT NULL`,
    [businessId, source]
  );
  return new Set(rows.map((r) => r.source_id));
}

// Give a business's existing books their journals.
//
// Everything recorded before the ledger existed — and anything the seed script
// writes as raw SQL — has a cash-book row and no entry behind it. Without this
// the ledger would start from the day it was built and every statement drawn
// from it would disagree with the books it sits on.
//
// Each row is posted from its own category exactly as a new one would be, so a
// backfilled entry is indistinguishable from one made at the time. Only the
// cash movements are replayed: the accrual halves (an invoice raised, a bill
// received) cannot be reconstructed honestly from a paid row, because the date
// it was earned is not in it. That is stated on the page rather than guessed at.
//
// Idempotent through the unique index on (business, source, source_id), so
// running it twice adds nothing.
export async function backfillJournals(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.kind, t.amount::float, t.category, t.note,
            to_char(t.occurred_on, 'YYYY-MM-DD') AS occurred_on
     FROM business_transactions t
     WHERE t.business_id = $1 AND t.user_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries e
         WHERE e.business_id = t.business_id
           AND e.source = 'bookkeeping' AND e.source_id = t.id
       )
     ORDER BY t.occurred_on, t.id`,
    [businessId, userId]
  );

  const client = await pool.connect();
  let posted = 0;
  try {
    await client.query("BEGIN");
    await ensureChart(businessId, userId, client);

    for (const row of rows) {
      const entry = await postEntry(client, {
        businessId,
        userId,
        lines: cashMovementEntry({
          kind: row.kind,
          category: row.category,
          amount: row.amount,
          memo: row.note
        }),
        memo: row.note,
        entryDate: row.occurred_on,
        source: "bookkeeping",
        sourceId: row.id
      });
      if (entry) posted += 1;
    }

    await client.query("COMMIT");
    return { considered: rows.length, posted };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// How much of the books the ledger has caught up with. Shown on the page so
// "the ledger is short" is a number rather than a suspicion.
export async function unpostedCount(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM business_transactions t
     WHERE t.business_id = $1 AND t.user_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries e
         WHERE e.business_id = t.business_id
           AND e.source = 'bookkeeping' AND e.source_id = t.id
       )`,
    [businessId, userId]
  );
  return rows[0].n;
}
