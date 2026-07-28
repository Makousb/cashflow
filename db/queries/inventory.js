import { pool } from "../index.js";

export async function listProducts(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM products
     WHERE business_id = $1 AND user_id = $2
     ORDER BY name`,
    [businessId, userId]
  );
  return rows;
}

export async function getProduct(id, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM products WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rows[0] || null;
}

export async function createProduct({
  businessId,
  userId,
  name,
  sku,
  quantity,
  unitCost,
  salePrice,
  reorderPoint,
  reorderQty,
  supplier
}) {
  const { rows } = await pool.query(
    `INSERT INTO products
       (business_id, user_id, name, sku, quantity, unit_cost, sale_price,
        reorder_point, reorder_qty, supplier)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [businessId, userId, name, sku, quantity, unitCost, salePrice,
     reorderPoint, reorderQty, supplier]
  );
  return rows[0];
}

// Change stock on hand by a signed delta, never below zero.
export async function adjustProductStock(id, userId, delta) {
  const { rows } = await pool.query(
    `UPDATE products
     SET quantity = GREATEST(quantity + $1, 0)
     WHERE id = $2 AND user_id = $3
     RETURNING *`,
    [delta, id, userId]
  );
  return rows[0] || null;
}

export async function deleteProduct(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM products WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}

export async function lowStockProducts(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM products
     WHERE business_id = $1 AND user_id = $2 AND quantity <= reorder_point
     ORDER BY name`,
    [businessId, userId]
  );
  return rows;
}

export async function inventorySummary(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS product_count,
       COALESCE(SUM(quantity * unit_cost), 0) AS stock_value,
       COUNT(*) FILTER (WHERE quantity <= reorder_point)::int AS low_count
     FROM products
     WHERE business_id = $1 AND user_id = $2`,
    [businessId, userId]
  );
  return rows[0];
}

// Create a purchase order plus its line items in one transaction.
export async function createPurchaseOrder({
  businessId,
  userId,
  supplier,
  note,
  items
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const total = items.reduce(
      (sum, i) => sum + Number(i.quantity) * Number(i.unitCost),
      0
    );

    const { rows } = await client.query(
      `INSERT INTO purchase_orders (business_id, user_id, supplier, note, total)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [businessId, userId, supplier, note, total]
    );
    const order = rows[0];

    for (const item of items) {
      await client.query(
        `INSERT INTO purchase_order_items (po_id, product_id, name, quantity, unit_cost)
         VALUES ($1, $2, $3, $4, $5)`,
        [order.id, item.productId, item.name, item.quantity, item.unitCost]
      );
    }

    await client.query("COMMIT");
    return order;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listPurchaseOrders(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT po.*,
            COUNT(i.id)::int AS item_count,
            COALESCE(SUM(i.quantity), 0) AS unit_count
     FROM purchase_orders po
     LEFT JOIN purchase_order_items i ON i.po_id = po.id
     WHERE po.business_id = $1 AND po.user_id = $2
     GROUP BY po.id
     ORDER BY po.created_at DESC`,
    [businessId, userId]
  );
  return rows;
}

// Receive an order: add each item's quantity to its product's stock, mark the
// order received, and return it (the caller posts the cost to the ledger).
export async function receivePurchaseOrder(id, userId, receivedOn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: orderRows } = await client.query(
      `UPDATE purchase_orders
       SET status = 'received', received_on = $3
       WHERE id = $1 AND user_id = $2 AND status = 'ordered'
       RETURNING *`,
      [id, userId, receivedOn]
    );
    const order = orderRows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return null;
    }

    const { rows: items } = await client.query(
      "SELECT product_id, quantity FROM purchase_order_items WHERE po_id = $1",
      [id]
    );
    for (const item of items) {
      if (item.product_id) {
        await client.query(
          "UPDATE products SET quantity = quantity + $1 WHERE id = $2",
          [item.quantity, item.product_id]
        );
      }
    }

    await client.query("COMMIT");
    return order;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deletePurchaseOrder(id, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM purchase_orders WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rowCount > 0;
}
