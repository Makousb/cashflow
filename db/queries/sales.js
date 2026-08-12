import { pool } from "../index.js";
import { postEntry } from "./ledger.js";
import { placeAt } from "./warehouse.js";
import { saleEntry } from "../../utils/ledger.js";

// Sales are the other half of inventory: buying stock puts units on the shelf,
// selling takes them off. Recording a sale therefore has to move stock and
// money together, so the whole thing runs in one transaction — including the
// ledger posting, which is why the inserts are written out here rather than
// going through the business/accounting query modules.

// Reserve the products a sale needs and confirm the shelves can cover it.
// Rows are locked so two tills cannot sell the same last unit.
async function claimStock(client, businessId, lines) {
  const shortfalls = [];
  const priced = [];

  for (const line of lines) {
    if (!line.productId) {
      // Not a stocked item (a service, a one-off) — nothing to reserve.
      priced.push({ ...line, unitCost: 0 });
      continue;
    }

    const { rows } = await client.query(
      `SELECT id, name, sku, quantity, unit_cost, sale_price
       FROM products
       WHERE id = $1 AND business_id = $2
       FOR UPDATE`,
      [line.productId, businessId]
    );
    const product = rows[0];
    if (!product) {
      shortfalls.push({ name: line.name, available: 0, wanted: line.quantity });
      continue;
    }

    const available = Number(product.quantity);
    if (available < line.quantity) {
      shortfalls.push({ name: product.name, available, wanted: line.quantity });
      continue;
    }

    priced.push({
      ...line,
      name: product.name,
      sku: product.sku,
      // The cost of these particular units, captured before it can drift.
      unitCost: Number(product.unit_cost),
      unitPrice: line.unitPrice ?? Number(product.sale_price)
    });
  }

  return { shortfalls, priced };
}

// Record a sale. Returns { shortfalls } instead of throwing when the stock
// isn't there, so the caller can tell the seller exactly what is short.
export async function createSale({
  businessId,
  userId,
  customer,
  payment,
  note,
  occurredOn,
  dueOn,
  lines,
  // Where the units came off. Null means the main store, which is what a
  // business with one location always means.
  locationId = null
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { shortfalls, priced } = await claimStock(client, businessId, lines);
    if (shortfalls.length > 0) {
      await client.query("ROLLBACK");
      return { shortfalls };
    }

    const total = priced.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
    const costTotal = priced.reduce((sum, l) => sum + l.quantity * l.unitCost, 0);

    const { rows: saleRows } = await client.query(
      `INSERT INTO sales
         (business_id, user_id, customer, payment, total, cost_total, note, occurred_on,
          location_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [businessId, userId, customer, payment, total, costTotal, note, occurredOn, locationId]
    );
    const sale = saleRows[0];

    for (const line of priced) {
      await client.query(
        `INSERT INTO sale_items
           (sale_id, product_id, name, sku, quantity, unit_price, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sale.id, line.productId || null, line.name, line.sku || null,
         line.quantity, line.unitPrice, line.unitCost]
      );

      if (line.productId) {
        await client.query(
          "UPDATE products SET quantity = quantity - $1 WHERE id = $2",
          [line.quantity, line.productId]
        );
        await placeAt(client, {
          businessId, userId, productId: line.productId,
          locationId, delta: -Number(line.quantity)
        });
      }
    }

    // Cash over the counter is income now; on credit it is a receivable, and
    // the income posts when the invoice is settled (same as the AR module).
    if (payment === "credit") {
      const { rows } = await client.query(
        `INSERT INTO invoices
           (business_id, user_id, customer, amount, category, issued_on, due_on, note)
         VALUES ($1, $2, $3, $4, 'Sales', $5, $6, $7)
         RETURNING id`,
        [businessId, userId, customer || "Walk-in customer", total, occurredOn,
         dueOn, `Sale #${sale.id}`]
      );
      await client.query("UPDATE sales SET invoice_id = $1 WHERE id = $2",
        [rows[0].id, sale.id]);
      sale.invoice_id = rows[0].id;
    } else if (total > 0) {
      const { rows } = await client.query(
        `INSERT INTO business_transactions
           (business_id, user_id, kind, amount, category, note, occurred_on)
         VALUES ($1, $2, 'income', $3, 'Sales', $4, $5)
         RETURNING id`,
        [businessId, userId, total, `Sale #${sale.id}`, occurredOn]
      );
      await client.query("UPDATE sales SET transaction_id = $1 WHERE id = $2",
        [rows[0].id, sale.id]);
      sale.transaction_id = rows[0].id;
    }

    // The journal for the sale, posted here rather than through the modules
    // above because both branches write their rows by hand — see the comment on
    // this function. One entry covers both halves of what a sale is: revenue
    // earned (as cash or as a receivable), and the cost of the goods leaving the
    // shelves. cost_total is what those units actually cost when they sold, so
    // the margin in the ledger is real rather than estimated.
    if (total > 0) {
      await postEntry(client, {
        businessId,
        userId,
        lines: saleEntry({
          total,
          cost: Number(sale.cost_total || 0),
          payment,
          memo: `Sale #${sale.id}`
        }),
        memo: `Sale #${sale.id}${customer ? ` — ${customer}` : ""}`,
        entryDate: occurredOn,
        source: "sale",
        sourceId: sale.id
      });
    }

    await client.query("COMMIT");
    return { sale, items: priced };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Void a sale: units go back on the shelf and the money is unbooked. A credit
// sale that has already been paid is left alone — unwinding settled cash
// belongs in the AR ledger, not here.
export async function voidSale(id, userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT * FROM sales WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [id, userId]
    );
    const sale = rows[0];
    if (!sale) {
      await client.query("ROLLBACK");
      return { missing: true };
    }

    if (sale.invoice_id) {
      const { rows: invoices } = await client.query(
        "SELECT status FROM invoices WHERE id = $1",
        [sale.invoice_id]
      );
      if (invoices[0]?.status === "paid") {
        await client.query("ROLLBACK");
        return { settled: true };
      }
    }

    const { rows: items } = await client.query(
      "SELECT product_id, quantity FROM sale_items WHERE sale_id = $1",
      [id]
    );
    for (const item of items) {
      if (item.product_id) {
        await client.query(
          "UPDATE products SET quantity = quantity + $1 WHERE id = $2",
          [item.quantity, item.product_id]
        );
        // Voiding puts the units back where the sale is recorded as having
        // taken them from — the sale's own location, or the main store.
        await placeAt(client, {
          businessId: sale.business_id, userId,
          productId: item.product_id,
          locationId: sale.location_id || null,
          delta: Number(item.quantity)
        });
      }
    }

    if (sale.transaction_id) {
      await client.query("DELETE FROM business_transactions WHERE id = $1",
        [sale.transaction_id]);
    }
    if (sale.invoice_id) {
      await client.query("DELETE FROM invoices WHERE id = $1", [sale.invoice_id]);
    }

    await client.query("DELETE FROM sales WHERE id = $1", [id]);
    await client.query("COMMIT");
    return { sale };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listSales(businessId, userId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT s.*,
            COUNT(i.id)::int AS line_count,
            COALESCE(SUM(i.quantity), 0) AS unit_count,
            inv.status AS invoice_status
     FROM sales s
     LEFT JOIN sale_items i ON i.sale_id = s.id
     LEFT JOIN invoices inv ON inv.id = s.invoice_id
     WHERE s.business_id = $1 AND s.user_id = $2
     GROUP BY s.id, inv.status
     ORDER BY s.occurred_on DESC, s.id DESC
     LIMIT $3`,
    [businessId, userId, limit]
  );
  return rows;
}

export async function listSaleItems(saleIds) {
  if (saleIds.length === 0) return [];
  const { rows } = await pool.query(
    "SELECT * FROM sale_items WHERE sale_id = ANY($1::int[]) ORDER BY id",
    [saleIds]
  );
  return rows;
}

// Revenue, cost and margin for today, this month, and all time.
export async function salesSummary(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(total) FILTER (WHERE occurred_on = CURRENT_DATE), 0) AS today_total,
       COUNT(*) FILTER (WHERE occurred_on = CURRENT_DATE)::int AS today_count,
       COALESCE(SUM(total) FILTER (WHERE occurred_on >= date_trunc('month', CURRENT_DATE)), 0) AS month_total,
       COALESCE(SUM(cost_total) FILTER (WHERE occurred_on >= date_trunc('month', CURRENT_DATE)), 0) AS month_cost,
       COUNT(*) FILTER (WHERE occurred_on >= date_trunc('month', CURRENT_DATE))::int AS month_count,
       COALESCE(SUM(total), 0) AS all_total,
       COALESCE(SUM(cost_total), 0) AS all_cost,
       COUNT(*)::int AS all_count
     FROM sales
     WHERE business_id = $1 AND user_id = $2`,
    [businessId, userId]
  );
  return rows[0];
}

// Best sellers by revenue, with the margin each one actually earned.
export async function topSellers(businessId, userId, limit = 8) {
  const { rows } = await pool.query(
    `SELECT i.name,
            SUM(i.quantity) AS units,
            SUM(i.quantity * i.unit_price) AS revenue,
            SUM(i.quantity * i.unit_cost) AS cost
     FROM sale_items i
     JOIN sales s ON s.id = i.sale_id
     WHERE s.business_id = $1 AND s.user_id = $2
     GROUP BY i.name
     ORDER BY revenue DESC
     LIMIT $3`,
    [businessId, userId, limit]
  );
  return rows;
}
