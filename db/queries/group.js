import { pool } from "../index.js";
import { ensureChart } from "./ledger.js";

// A group of businesses: a parent and the branches under it. Who owns whom and
// what each one's figures are; converting and adding them up is
// utils/jurisdictions.js's job, because that is arithmetic and belongs
// somewhere it can be tested without a database.

// The branches directly under a business.
export async function listSubsidiaries(parentId, userId) {
  const { rows } = await pool.query(
    `SELECT id, name, industry, jurisdiction, base_currency, income_tax_rate,
            sales_tax_rate, created_at
     FROM businesses
     WHERE parent_id = $1 AND user_id = $2
     ORDER BY name`,
    [parentId, userId]
  );
  return rows;
}

// The whole group a business belongs to, from the top down. Walks upward first
// so opening a branch shows the same group as opening its parent — a person
// looking at the Kampala books still wants the group's figures, not a group of
// one with themselves at the head of it.
export async function groupFor(businessId, userId) {
  const { rows: roots } = await pool.query(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id FROM businesses WHERE id = $1 AND user_id = $2
       UNION ALL
       SELECT b.id, b.parent_id FROM businesses b JOIN up ON b.id = up.parent_id
     )
     SELECT id FROM up WHERE parent_id IS NULL LIMIT 1`,
    [businessId, userId]
  );
  // A business with no parent is the root of its own group.
  const rootId = roots[0]?.id ?? businessId;

  const { rows: members } = await pool.query(
    `WITH RECURSIVE down AS (
       SELECT * FROM businesses WHERE id = $1 AND user_id = $2
       UNION ALL
       SELECT b.* FROM businesses b JOIN down ON b.parent_id = down.id
     )
     SELECT id, name, industry, parent_id, jurisdiction, base_currency,
            income_tax_rate, sales_tax_rate
     FROM down
     ORDER BY (parent_id IS NULL) DESC, name`,
    [rootId, userId]
  );

  return { rootId, members, parent: members.find((m) => m.id === rootId) || null };
}

// Open a branch under a business. Same shape as createBusiness — a share code
// stamped in a second statement and a chart of accounts opened — because a
// subsidiary is a business in every respect except who it answers to.
export async function createSubsidiary({ parentId, userId, name, industry, jurisdiction, currency }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: created } = await client.query(
      `INSERT INTO businesses (user_id, name, industry, parent_id, jurisdiction, base_currency)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [userId, name, industry, parentId, jurisdiction, currency]
    );

    const { rows } = await client.query(
      `UPDATE businesses
       SET supply_code = 'CF-' || upper(substr(md5('cashflow-supply-' || id::text), 1, 6))
       WHERE id = $1
       RETURNING *`,
      [created[0].id]
    );

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

// Where a business trades and what it keeps its books in.
export async function setPlace({ businessId, userId, jurisdiction, currency, incomeTaxRate, salesTaxRate }) {
  const { rows } = await pool.query(
    `UPDATE businesses
     SET jurisdiction = $3, base_currency = $4,
         income_tax_rate = $5, sales_tax_rate = $6
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [businessId, userId, jurisdiction, currency, incomeTaxRate, salesTaxRate]
  );
  return rows[0] || null;
}

// Move a business under a parent, or out on its own when parentId is null.
//
// ★ A business may not become its own ancestor. Without this check a two-click
// mistake makes a cycle, and the recursive walks above then run until Postgres
// stops them — the group page would simply hang.
export async function setParent({ businessId, userId, parentId }) {
  if (parentId != null) {
    if (parentId === businessId) return { ok: false, reason: "A business cannot be its own parent." };

    const { rows } = await pool.query(
      `WITH RECURSIVE down AS (
         SELECT id FROM businesses WHERE id = $1 AND user_id = $2
         UNION ALL
         SELECT b.id FROM businesses b JOIN down ON b.parent_id = down.id
       )
       SELECT 1 FROM down WHERE id = $3`,
      [businessId, userId, parentId]
    );
    if (rows.length > 0) {
      return { ok: false, reason: "That would put a business underneath one of its own branches." };
    }
  }

  const { rows } = await pool.query(
    `UPDATE businesses SET parent_id = $3
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [businessId, userId, parentId]
  );
  return rows[0] ? { ok: true, business: rows[0] } : { ok: false, reason: "Business not found." };
}

// The consumption tax a business has charged and been charged, off the ledger.
//
// Revenue and expenses are recorded tax-inclusive here — a shop types what it
// took, not what it took before VAT — so the tax is extracted from the totals
// rather than summed from a column that does not exist. That approximation is
// stated on the page; per-line tax would need every sale and bill to carry a
// rate, which is a bigger change than this one.
export async function taxableTotals(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(l.credit) FILTER (WHERE a.type = 'income'), 0)::float AS income,
       COALESCE(SUM(l.debit) FILTER (WHERE a.type = 'expense' AND a.key <> 'payroll_expense'), 0)::float
         AS deductible,
       COALESCE(SUM(l.debit) FILTER (WHERE a.key = 'inventory'), 0)::float AS purchases
     FROM journal_lines l
     JOIN journal_entries e ON e.id = l.entry_id
     JOIN ledger_accounts a ON a.id = l.account_id
     WHERE e.business_id = $1 AND e.user_id = $2`,
    [businessId, userId]
  );
  return rows[0];
}

// Headline figures per entity for the consolidation, straight off each one's
// ledger so a group total is the sum of real ledgers rather than of estimates.
export async function groupFigures(businessIds, userId) {
  if (businessIds.length === 0) return new Map();

  const { rows } = await pool.query(
    `SELECT e.business_id,
            COALESCE(SUM(l.credit) FILTER (WHERE a.type = 'income'), 0)::float
              - COALESCE(SUM(l.debit) FILTER (WHERE a.type = 'income'), 0)::float AS revenue,
            COALESCE(SUM(l.debit) FILTER (WHERE a.type = 'expense'), 0)::float
              - COALESCE(SUM(l.credit) FILTER (WHERE a.type = 'expense'), 0)::float AS expenses,
            COALESCE(SUM(l.debit) FILTER (WHERE a.type = 'asset'), 0)::float
              - COALESCE(SUM(l.credit) FILTER (WHERE a.type = 'asset'), 0)::float AS assets,
            COALESCE(SUM(l.credit) FILTER (WHERE a.type = 'liability'), 0)::float
              - COALESCE(SUM(l.debit) FILTER (WHERE a.type = 'liability'), 0)::float AS liabilities
     FROM journal_entries e
     JOIN journal_lines l ON l.entry_id = e.id
     JOIN ledger_accounts a ON a.id = l.account_id
     WHERE e.business_id = ANY($1::int[]) AND e.user_id = $2
     GROUP BY e.business_id`,
    [businessIds, userId]
  );

  const byId = new Map();
  for (const row of rows) {
    byId.set(row.business_id, {
      revenue: row.revenue,
      expenses: row.expenses,
      netProfit: Math.round((row.revenue - row.expenses) * 100) / 100,
      assets: row.assets,
      liabilities: row.liabilities
    });
  }

  // An entity that has posted nothing still belongs in the group, at zero.
  for (const id of businessIds) {
    if (!byId.has(id)) {
      byId.set(id, { revenue: 0, expenses: 0, netProfit: 0, assets: 0, liabilities: 0 });
    }
  }
  return byId;
}
