import { pool } from "../index.js";
import { postEntry } from "./ledger.js";
import { provisionEntry, provisionReversedEntry } from "../../utils/ledger.js";

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

// Providing for tax now accrues it: the charge lands in the period and the
// obligation sits as a liability until it is remitted. No cash moves — the page
// calls this "setting aside", but the entry is about the owing, not the money.
export async function addProvision({ businessId, userId, amount, note, setOn }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO tax_provisions (business_id, user_id, amount, note, set_on)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [businessId, userId, amount, note, setOn]
    );
    const provision = rows[0];

    await postEntry(client, {
      businessId,
      userId,
      lines: provisionEntry({ amount, memo: note || "Provision for tax" }),
      memo: note ? `Tax provision: ${note}` : "Provision for tax",
      entryDate: setOn,
      source: "provision",
      sourceId: provision.id
    });

    await client.query("COMMIT");
    return provision;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Taking a provision back REVERSES it rather than deleting the entry. A ledger
// whose lines can vanish is worth less than one whose cannot: every other
// posting here can be traced to what caused it, and an owner who provided
// 50,000 in March and took it back in April should be able to see both.
export async function deleteProvision(id, userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "DELETE FROM tax_provisions WHERE id = $1 AND user_id = $2 RETURNING *",
      [id, userId]
    );
    const removed = rows[0];
    if (!removed) {
      await client.query("ROLLBACK");
      return false;
    }

    // Only if it was ever posted. A provision made before this shipped has no
    // entry to reverse until the backfill has run over it.
    const { rows: posted } = await client.query(
      `SELECT 1 FROM journal_entries
       WHERE business_id = $1 AND source = 'provision' AND source_id = $2`,
      [removed.business_id, removed.id]
    );

    if (posted.length > 0) {
      await postEntry(client, {
        businessId: removed.business_id,
        userId,
        lines: provisionReversedEntry({
          amount: Number(removed.amount),
          memo: "Provision withdrawn"
        }),
        memo: `Tax provision withdrawn${removed.note ? `: ${removed.note}` : ""}`,
        entryDate: null,
        // A different source from the original, so the partial unique index on
        // (business, source, source_id) lets the pair coexist and still stops
        // either half being written twice.
        source: "provision_reversed",
        sourceId: removed.id
      });
    }

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Provisions recorded before they accrued. Same shape as the ledger's own
// backfill and idempotent for the same reason — the unique index on the source
// means a second run posts nothing.
export async function backfillProvisions(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.amount::float, p.note, to_char(p.set_on, 'YYYY-MM-DD') AS set_on
     FROM tax_provisions p
     WHERE p.business_id = $1 AND p.user_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries e
         WHERE e.business_id = p.business_id
           AND e.source = 'provision' AND e.source_id = p.id
       )
     ORDER BY p.set_on, p.id`,
    [businessId, userId]
  );

  const client = await pool.connect();
  let posted = 0;
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      const entry = await postEntry(client, {
        businessId,
        userId,
        lines: provisionEntry({ amount: row.amount, memo: row.note || "Provision for tax" }),
        memo: row.note ? `Tax provision: ${row.note}` : "Provision for tax",
        entryDate: row.set_on,
        source: "provision",
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
