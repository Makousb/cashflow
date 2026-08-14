import { pool } from "../index.js";

// Suppliers are their own account side: a catalog and the orders against it.
// They do not keep books here, so there is no ledger, no invoices and no tax —
// an order records what it is worth and whether it has been paid.

const CODE = `'CF-' || upper(substr(md5('cashflow-supply-s' || id::text), 1, 6))`;

export async function createSupplier({ userId, name, industry, leadTimeDays }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: created } = await client.query(
      `INSERT INTO suppliers (user_id, name, industry, lead_time_days)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [userId, name, industry || null, leadTimeDays || 3]
    );
    // The code derives from the row's id, so it takes a second statement:
    // Postgres gives every part of one statement the same snapshot.
    const { rows } = await client.query(
      `UPDATE suppliers SET supply_code = ${CODE} WHERE id = $1 RETURNING *`,
      [created[0].id]
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Whether the "Supplier" link belongs in the nav for this login. Cheap on
// purpose, like hasAnyBusiness: it runs on every authenticated page, unlike
// listSuppliers, which carries three correlated subqueries this does not need.
export async function hasAnySupplier(userId) {
  const { rows } = await pool.query(
    "SELECT EXISTS(SELECT 1 FROM suppliers WHERE user_id = $1) AS exists",
    [userId]
  );
  return rows[0].exists;
}

export async function listSuppliers(userId) {
  const { rows } = await pool.query(
    `SELECT s.*,
            (SELECT COUNT(*)::int FROM supplier_products p WHERE p.supplier_id = s.id) AS catalog_size,
            (SELECT COUNT(*)::int FROM supply_orders o
              WHERE o.supplier_id = s.id AND o.status IN ('placed','confirmed','shipped','delivered')) AS open_orders,
            -- A buyer waiting on an answer is the one thing here that needs
            -- the owner to do something, so it is counted on the list rather
            -- than only on the page they would have to open to find it.
            (SELECT COUNT(*)::int FROM trade_partners t
              WHERE t.supplier_id = s.id AND t.status = 'pending') AS pending_requests
     FROM suppliers s
     WHERE s.user_id = $1
     ORDER BY s.created_at`,
    [userId]
  );
  return rows;
}

export async function getSupplier(id, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM suppliers WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rows[0] || null;
}

// Used across the trade: a buyer needs the supplier's details and the currency
// its owner prices in.
export async function getTradingSupplier(id) {
  const { rows } = await pool.query(
    `SELECT s.*, u.base_currency
     FROM suppliers s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function findSupplierByCode(code) {
  const { rows } = await pool.query(
    `SELECT s.*, u.base_currency
     FROM suppliers s JOIN users u ON u.id = s.user_id
     WHERE upper(s.supply_code) = upper($1)`,
    [code]
  );
  return rows[0] || null;
}

export async function updateSupplierProfile(id, userId, { acceptingOrders, leadTimeDays }) {
  const { rows } = await pool.query(
    `UPDATE suppliers SET accepting_orders = $3, lead_time_days = $4
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [id, userId, acceptingOrders, leadTimeDays]
  );
  return rows[0] || null;
}

// --- Catalog ---

export async function listCatalog(supplierId) {
  const { rows } = await pool.query(
    "SELECT * FROM supplier_products WHERE supplier_id = $1 ORDER BY name",
    [supplierId]
  );
  return rows;
}

export async function addCatalogProduct({
  supplierId, userId, name, sku, quantity, unitCost, salePrice
}) {
  const { rows } = await pool.query(
    `INSERT INTO supplier_products
       (supplier_id, user_id, name, sku, quantity, unit_cost, sale_price)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [supplierId, userId, name, sku || null, quantity, unitCost, salePrice]
  );
  return rows[0];
}

export async function adjustCatalogStock(id, userId, delta) {
  const { rows } = await pool.query(
    `UPDATE supplier_products
     SET quantity = GREATEST(quantity + $3, 0)
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [id, userId, delta]
  );
  return rows[0] || null;
}

export async function removeCatalogProduct(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM supplier_products WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}

// --- What the supplier is owed ---

export async function supplierLedger(supplierId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(total) FILTER (WHERE status NOT IN ('cancelled','declined')), 0) AS won,
       COALESCE(SUM(total) FILTER (WHERE status IN ('shipped','delivered','received') AND paid_at IS NULL), 0) AS outstanding,
       COALESCE(SUM(total) FILTER (WHERE paid_at IS NOT NULL), 0) AS paid,
       COUNT(*) FILTER (WHERE status IN ('placed','confirmed'))::int AS to_fulfil
     FROM supply_orders WHERE supplier_id = $1`,
    [supplierId]
  );
  return rows[0];
}

export async function markOrderPaid(orderId, supplierId) {
  const { rows } = await pool.query(
    `UPDATE supply_orders SET paid_at = NOW()
     WHERE id = $1 AND supplier_id = $2 AND paid_at IS NULL
     RETURNING *`,
    [orderId, supplierId]
  );
  return rows[0] || null;
}
