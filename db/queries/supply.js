import { pool } from "../index.js";

// Supply chain data access. Unlike the rest of the business suite these rows
// are shared between two businesses that may belong to different users, so
// they are scoped by business id and access is authorised by the trading
// relationship (see requireOrderAccess in the controller) rather than by
// user_id on every query.

const ORDER_COLUMNS = `
  o.*,
  buyer.name AS buyer_name,
  supplier.name AS supplier_name,
  supplier.lead_time_days AS supplier_lead_time,
  COUNT(i.id)::int AS item_count,
  COALESCE(SUM(i.quantity), 0) AS unit_count
`;

// --- Supplier profile ---

// Every business has a share code; generate one lazily for rows created after
// the schema backfill ran.
export async function ensureSupplyCode(businessId) {
  const { rows } = await pool.query(
    `UPDATE businesses
     SET supply_code = 'CF-' || upper(substr(md5('cashflow-supply-' || id::text), 1, 6))
     WHERE id = $1 AND supply_code IS NULL
     RETURNING supply_code`,
    [businessId]
  );
  return rows[0]?.supply_code || null;
}

export async function updateSupplyProfile(businessId, userId, { isSupplier, leadTimeDays }) {
  const { rows } = await pool.query(
    `UPDATE businesses
     SET is_supplier = $3, lead_time_days = $4
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [businessId, userId, isSupplier, leadTimeDays]
  );
  return rows[0] || null;
}

// A business plus its owner's storage currency — needed whenever we price a
// catalog across two businesses.
export async function getTradingBusiness(id) {
  const { rows } = await pool.query(
    `SELECT b.*, u.base_currency, u.currency AS owner_currency
     FROM businesses b
     JOIN users u ON u.id = b.user_id
     WHERE b.id = $1`,
    [id]
  );
  return rows[0] || null;
}

export async function findBusinessByCode(code) {
  const { rows } = await pool.query(
    `SELECT b.*, u.base_currency
     FROM businesses b
     JOIN users u ON u.id = b.user_id
     WHERE upper(b.supply_code) = upper($1)`,
    [code]
  );
  return rows[0] || null;
}

// --- Trading relationships ---

// Suppliers this business buys from.
export async function listSuppliersFor(buyerBusinessId) {
  const { rows } = await pool.query(
    `SELECT p.*, b.name, b.industry, b.supply_code, b.lead_time_days, b.is_supplier,
            (SELECT COUNT(*)::int FROM products pr WHERE pr.business_id = b.id) AS catalog_size
     FROM trade_partners p
     JOIN businesses b ON b.id = p.supplier_business_id
     WHERE p.buyer_business_id = $1
     ORDER BY p.status, b.name`,
    [buyerBusinessId]
  );
  return rows;
}

// Buyers that order from this business.
export async function listBuyersFor(supplierBusinessId) {
  const { rows } = await pool.query(
    `SELECT p.*, b.name, b.industry, b.supply_code
     FROM trade_partners p
     JOIN businesses b ON b.id = p.buyer_business_id
     WHERE p.supplier_business_id = $1
     ORDER BY p.status, b.name`,
    [supplierBusinessId]
  );
  return rows;
}

export async function getPartnership(buyerBusinessId, supplierBusinessId) {
  const { rows } = await pool.query(
    `SELECT * FROM trade_partners
     WHERE buyer_business_id = $1 AND supplier_business_id = $2`,
    [buyerBusinessId, supplierBusinessId]
  );
  return rows[0] || null;
}

export async function requestPartnership({
  buyerBusinessId,
  supplierBusinessId,
  requestedBy,
  status = "pending"
}) {
  const { rows } = await pool.query(
    `INSERT INTO trade_partners
       (buyer_business_id, supplier_business_id, requested_by, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (buyer_business_id, supplier_business_id)
     DO UPDATE SET status = CASE
       WHEN trade_partners.status = 'declined' THEN 'pending'
       ELSE trade_partners.status
     END
     RETURNING *`,
    [buyerBusinessId, supplierBusinessId, requestedBy, status]
  );
  return rows[0];
}

// Only the supplier decides whether a request becomes a relationship.
export async function setPartnershipStatus(id, supplierBusinessId, status) {
  const { rows } = await pool.query(
    `UPDATE trade_partners
     SET status = $3
     WHERE id = $1 AND supplier_business_id = $2
     RETURNING *`,
    [id, supplierBusinessId, status]
  );
  return rows[0] || null;
}

// Either side can walk away.
export async function deletePartnership(id, businessId) {
  const { rows } = await pool.query(
    `DELETE FROM trade_partners
     WHERE id = $1 AND (buyer_business_id = $2 OR supplier_business_id = $2)
     RETURNING *`,
    [id, businessId]
  );
  return rows[0] || null;
}

// --- Catalog ---

// What a supplier sells, priced in their own storage currency.
export async function supplierCatalog(supplierBusinessId) {
  const { rows } = await pool.query(
    `SELECT id, name, sku, quantity, sale_price, unit_cost
     FROM products
     WHERE business_id = $1
     ORDER BY name`,
    [supplierBusinessId]
  );
  return rows;
}

// --- Orders ---

export async function createSupplyOrder({
  buyerBusinessId,
  buyerUserId,
  supplierBusinessId,
  supplierUserId,
  currency,
  note,
  expectedOn,
  placedOn,
  items
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const total = items.reduce(
      (sum, i) => sum + Number(i.quantity) * Number(i.unitPrice),
      0
    );

    const { rows } = await client.query(
      `INSERT INTO supply_orders
         (buyer_business_id, buyer_user_id, supplier_business_id, supplier_user_id,
          currency, note, expected_on, placed_on, total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [buyerBusinessId, buyerUserId, supplierBusinessId, supplierUserId,
       currency, note, expectedOn, placedOn, total]
    );
    const order = rows[0];

    for (const item of items) {
      await client.query(
        `INSERT INTO supply_order_items
           (order_id, supplier_product_id, buyer_product_id, name, sku, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [order.id, item.supplierProductId || null, item.buyerProductId || null,
         item.name, item.sku || null, item.quantity, item.unitPrice]
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

// Every order this business is party to, on either side.
export async function listOrdersFor(businessId, limit = 200) {
  const { rows } = await pool.query(
    `SELECT ${ORDER_COLUMNS},
            CASE WHEN o.buyer_business_id = $1 THEN 'buyer' ELSE 'supplier' END AS role
     FROM supply_orders o
     JOIN businesses buyer ON buyer.id = o.buyer_business_id
     JOIN businesses supplier ON supplier.id = o.supplier_business_id
     LEFT JOIN supply_order_items i ON i.order_id = o.id
     WHERE o.buyer_business_id = $1 OR o.supplier_business_id = $1
     GROUP BY o.id, buyer.name, supplier.name, supplier.lead_time_days
     ORDER BY o.created_at DESC
     LIMIT $2`,
    [businessId, limit]
  );
  return rows;
}

export async function getOrder(id) {
  const { rows } = await pool.query(
    `SELECT ${ORDER_COLUMNS},
            buyer.supply_code AS buyer_code,
            supplier.supply_code AS supplier_code,
            supplier.industry AS supplier_industry
     FROM supply_orders o
     JOIN businesses buyer ON buyer.id = o.buyer_business_id
     JOIN businesses supplier ON supplier.id = o.supplier_business_id
     LEFT JOIN supply_order_items i ON i.order_id = o.id
     WHERE o.id = $1
     GROUP BY o.id, buyer.name, supplier.name, supplier.lead_time_days,
              buyer.supply_code, supplier.supply_code, supplier.industry`,
    [id]
  );
  return rows[0] || null;
}

export async function listOrderItems(orderId) {
  const { rows } = await pool.query(
    "SELECT * FROM supply_order_items WHERE order_id = $1 ORDER BY id",
    [orderId]
  );
  return rows;
}

// Line items across every order this business is party to, for the reports.
export async function listItemsFor(businessId, role = "buyer") {
  const column = role === "buyer" ? "buyer_business_id" : "supplier_business_id";
  const { rows } = await pool.query(
    `SELECT i.*, o.status, o.placed_on, o.currency
     FROM supply_order_items i
     JOIN supply_orders o ON o.id = i.order_id
     WHERE o.${column} = $1 AND o.status NOT IN ('cancelled', 'declined')`,
    [businessId]
  );
  return rows;
}

// Move an order to `status`, but only from one of the states that allows it.
export async function advanceOrder(id, { from, status, stampColumn, fields = {} }) {
  const sets = ["status = $3"];
  const values = [id, from, status];
  let index = 4;

  if (stampColumn) {
    sets.push(`${stampColumn} = NOW()`);
  }
  for (const [column, value] of Object.entries(fields)) {
    sets.push(`${column} = $${index}`);
    values.push(value);
    index += 1;
  }

  const { rows } = await pool.query(
    `UPDATE supply_orders
     SET ${sets.join(", ")}
     WHERE id = $1 AND status = ANY($2::text[])
     RETURNING *`,
    values
  );
  return rows[0] || null;
}

// Ship: mark the order gone and take the units off the supplier's own shelves.
export async function shipSupplyOrder(id, tracking) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE supply_orders
       SET status = 'shipped', shipped_at = NOW(), tracking = $2
       WHERE id = $1 AND status IN ('placed', 'confirmed')
       RETURNING *`,
      [id, tracking]
    );
    const order = rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return null;
    }

    const { rows: items } = await client.query(
      "SELECT supplier_product_id, quantity FROM supply_order_items WHERE order_id = $1",
      [id]
    );
    for (const item of items) {
      if (item.supplier_product_id) {
        await client.query(
          `UPDATE products
           SET quantity = GREATEST(quantity - $1, 0)
           WHERE id = $2`,
          [item.quantity, item.supplier_product_id]
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

// Receive: mark the order arrived and stock the buyer's inventory. Lines are
// matched to an existing product by id, then by SKU or name; anything still
// unmatched becomes a new product so nothing arrives untracked.
export async function receiveSupplyOrder(id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE supply_orders
       SET status = 'received', received_at = NOW()
       WHERE id = $1 AND status IN ('shipped', 'delivered')
       RETURNING *`,
      [id]
    );
    const order = rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return null;
    }

    const { rows: items } = await client.query(
      "SELECT * FROM supply_order_items WHERE order_id = $1",
      [id]
    );

    const stocked = [];
    for (const item of items) {
      let productId = item.buyer_product_id;

      if (!productId) {
        const { rows: matches } = await client.query(
          `SELECT id FROM products
           WHERE business_id = $1
             AND (($2::text IS NOT NULL AND upper(sku) = upper($2))
                  OR lower(name) = lower($3))
           ORDER BY id
           LIMIT 1`,
          [order.buyer_business_id, item.sku, item.name]
        );
        productId = matches[0]?.id || null;
      }

      if (productId) {
        // Latest purchase price becomes the stock's carrying cost.
        await client.query(
          `UPDATE products
           SET quantity = quantity + $1, unit_cost = $2
           WHERE id = $3`,
          [item.quantity, item.unit_price, productId]
        );
      } else {
        const { rows: created } = await client.query(
          `INSERT INTO products
             (business_id, user_id, name, sku, quantity, unit_cost, sale_price,
              reorder_point, reorder_qty, supplier)
           VALUES ($1, $2, $3, $4, $5, $6, $6, 0, $5,
                   (SELECT name FROM businesses WHERE id = $7))
           RETURNING id`,
          [order.buyer_business_id, order.buyer_user_id, item.name, item.sku,
           item.quantity, item.unit_price, order.supplier_business_id]
        );
        productId = created[0].id;
      }

      await client.query(
        "UPDATE supply_order_items SET buyer_product_id = $1 WHERE id = $2",
        [productId, item.id]
      );
      stocked.push({ ...item, buyer_product_id: productId });
    }

    await client.query("COMMIT");
    return { order, items: stocked };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function linkOrderDocument(id, column, documentId) {
  const { rows } = await pool.query(
    `UPDATE supply_orders SET ${column} = $2 WHERE id = $1 RETURNING *`,
    [id, documentId]
  );
  return rows[0] || null;
}

// How long past deliveries from this supplier actually took, newest first.
export async function deliveryHistory(buyerBusinessId, supplierBusinessId, limit = 8) {
  const { rows } = await pool.query(
    `SELECT id, placed_on, delivered_at
     FROM supply_orders
     WHERE buyer_business_id = $1 AND supplier_business_id = $2
       AND delivered_at IS NOT NULL
     ORDER BY delivered_at DESC
     LIMIT $3`,
    [buyerBusinessId, supplierBusinessId, limit]
  );
  return rows;
}

// --- Order thread ---

export async function listMessages(orderId, limit = 200) {
  const { rows } = await pool.query(
    `SELECT m.*, b.name AS business_name, u.name AS user_name
     FROM supply_messages m
     LEFT JOIN businesses b ON b.id = m.business_id
     LEFT JOIN users u ON u.id = m.user_id
     WHERE m.order_id = $1
     ORDER BY m.id
     LIMIT $2`,
    [orderId, limit]
  );
  return rows;
}

export async function addMessage({ orderId, businessId, userId, kind = "message", body }) {
  const { rows } = await pool.query(
    `INSERT INTO supply_messages (order_id, business_id, user_id, kind, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [orderId, businessId, userId, kind, body]
  );
  const message = rows[0];

  const { rows: named } = await pool.query(
    `SELECT b.name AS business_name, u.name AS user_name
     FROM (SELECT $1::int AS bid, $2::int AS uid) ids
     LEFT JOIN businesses b ON b.id = ids.bid
     LEFT JOIN users u ON u.id = ids.uid`,
    [businessId, userId]
  );

  return { ...message, ...named[0] };
}
