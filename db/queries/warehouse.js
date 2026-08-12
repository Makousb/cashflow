import { pool } from "../index.js";

// Stock locations and where each product's units sit.
//
// The one rule everything here serves: whenever products.quantity moves, the
// placement moves with it, in the same transaction. `placeAt` is the only way
// that happens, and every stock path in the app calls it — which is why the
// total and the placements cannot drift apart through ordinary use.

// The location stock lands at when nothing says otherwise. Created on demand so
// a business that has never opened the page still has somewhere to put things.
export async function ensureDefaultLocation(businessId, userId, client = pool) {
  const { rows } = await client.query(
    "SELECT * FROM stock_locations WHERE business_id = $1 AND is_default LIMIT 1",
    [businessId]
  );
  if (rows[0]) return rows[0];

  const { rows: created } = await client.query(
    `INSERT INTO stock_locations (business_id, user_id, name, code, is_default)
     VALUES ($1, $2, 'Main store', 'MAIN', TRUE)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [businessId, userId]
  );
  if (created[0]) return created[0];

  // Another transaction created it between the read and the write.
  const { rows: existing } = await client.query(
    "SELECT * FROM stock_locations WHERE business_id = $1 AND is_default LIMIT 1",
    [businessId]
  );
  return existing[0];
}

export async function listLocations(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT id, name, code, is_default, notes, active
     FROM stock_locations
     WHERE business_id = $1 AND user_id = $2
     ORDER BY is_default DESC, name`,
    [businessId, userId]
  );
  return rows;
}

export async function createLocation({ businessId, userId, name, code, notes }) {
  const { rows } = await pool.query(
    `INSERT INTO stock_locations (business_id, user_id, name, code, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [businessId, userId, name, code || null, notes || null]
  );
  return rows[0];
}

// Move which location is the default. Two statements in one transaction: the
// partial unique index means the old default has to stand down before the new
// one can stand up, and doing it the other way round fails.
export async function makeDefault({ locationId, businessId, userId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE stock_locations SET is_default = FALSE WHERE business_id = $1 AND user_id = $2",
      [businessId, userId]
    );
    const { rows } = await client.query(
      `UPDATE stock_locations SET is_default = TRUE
       WHERE id = $1 AND business_id = $2 AND user_id = $3
       RETURNING *`,
      [locationId, businessId, userId]
    );
    await client.query("COMMIT");
    return rows[0] || null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Put units at a location, or take them away with a negative delta.
//
// ★ This is the function every stock path calls alongside its own change to
// products.quantity, inside that path's transaction. A location of null means
// "wherever the default is", which is what the paths that do not name one want.
export async function placeAt(client, { businessId, userId, productId, locationId, delta }) {
  const amount = Number(delta);
  if (!Number.isFinite(amount) || amount === 0) return null;

  const location = locationId
    ? { id: locationId }
    : await ensureDefaultLocation(businessId, userId, client);
  if (!location) return null;

  const { rows } = await client.query(
    `INSERT INTO product_stock (product_id, location_id, quantity)
     VALUES ($1, $2, $3)
     ON CONFLICT (product_id, location_id)
     DO UPDATE SET quantity = product_stock.quantity + EXCLUDED.quantity
     RETURNING *`,
    [productId, location.id, amount]
  );
  return rows[0];
}

// Every placement for a business's products, with the location named so the
// pure code can shape it without a second query.
export async function stockRows(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT ps.product_id, ps.location_id, ps.quantity::float,
            l.name AS location_name, l.code AS location_code, l.is_default
     FROM product_stock ps
     JOIN stock_locations l ON l.id = ps.location_id
     JOIN products p ON p.id = ps.product_id
     WHERE l.business_id = $1 AND l.user_id = $2 AND p.business_id = $1`,
    [businessId, userId]
  );
  return rows;
}

// How many of a product are at one location, for checking a transfer against
// something real rather than against what a form claimed.
export async function heldAt(productId, locationId, client = pool) {
  const { rows } = await client.query(
    "SELECT quantity::float FROM product_stock WHERE product_id = $1 AND location_id = $2",
    [productId, locationId]
  );
  return rows[0]?.quantity ?? 0;
}

// Move stock from one place to another. The total never changes — nothing was
// bought or sold — so products.quantity is deliberately untouched here.
//
// The source row is locked and re-checked inside the transaction: a form says
// what was true when the page was drawn, and two people moving the same crate
// at once must not both succeed.
export async function transferStock({
  businessId, userId, productId, fromId, toId, quantity, note, movedOn
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: source } = await client.query(
      `SELECT ps.quantity::float FROM product_stock ps
       JOIN stock_locations l ON l.id = ps.location_id
       WHERE ps.product_id = $1 AND ps.location_id = $2
         AND l.business_id = $3 AND l.user_id = $4
       FOR UPDATE OF ps`,
      [productId, fromId, businessId, userId]
    );

    const available = source[0]?.quantity ?? 0;
    if (available < Number(quantity)) {
      await client.query("ROLLBACK");
      return { ok: false, available };
    }

    await placeAt(client, { businessId, userId, productId, locationId: fromId, delta: -quantity });
    await placeAt(client, { businessId, userId, productId, locationId: toId, delta: quantity });

    const { rows } = await client.query(
      `INSERT INTO stock_transfers
         (business_id, user_id, product_id, from_location_id, to_location_id,
          quantity, note, moved_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, CURRENT_DATE))
       RETURNING *`,
      [businessId, userId, productId, fromId, toId, quantity, note || null, movedOn || null]
    );

    await client.query("COMMIT");
    return { ok: true, transfer: rows[0] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listTransfers(businessId, userId, limit = 30) {
  const { rows } = await pool.query(
    `SELECT t.id, t.quantity::float, t.note,
            to_char(t.moved_on, 'YYYY-MM-DD') AS moved_on,
            p.name AS product_name,
            f.name AS from_name, d.name AS to_name
     FROM stock_transfers t
     JOIN products p ON p.id = t.product_id
     LEFT JOIN stock_locations f ON f.id = t.from_location_id
     LEFT JOIN stock_locations d ON d.id = t.to_location_id
     WHERE t.business_id = $1 AND t.user_id = $2
     ORDER BY t.moved_on DESC, t.id DESC
     LIMIT $3`,
    [businessId, userId, limit]
  );
  return rows;
}

// Place whatever has never been placed — the stock that was on the shelves
// before locations existed, or that arrived through a path that named none.
// Idempotent: run it twice and the second run finds nothing.
export async function placeUnplaced({ businessId, userId, locationId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Loaded rather than assumed from the id: the caller gets the row back and
    // names it in what it tells the person, and "placed at undefined" is not a
    // sentence. Scoped to the business, so an id from elsewhere finds nothing.
    let location = null;
    if (locationId) {
      const { rows } = await client.query(
        "SELECT * FROM stock_locations WHERE id = $1 AND business_id = $2 AND user_id = $3",
        [locationId, businessId, userId]
      );
      location = rows[0] || null;
    }
    if (!location) location = await ensureDefaultLocation(businessId, userId, client);

    const { rows } = await client.query(
      `SELECT p.id, p.quantity::float
              - COALESCE((SELECT SUM(ps.quantity) FROM product_stock ps
                          WHERE ps.product_id = p.id), 0)::float AS unplaced
       FROM products p
       WHERE p.business_id = $1 AND p.user_id = $2`,
      [businessId, userId]
    );

    let placed = 0;
    for (const row of rows) {
      if (row.unplaced <= 0) continue;
      await placeAt(client, {
        businessId, userId, productId: row.id, locationId: location.id, delta: row.unplaced
      });
      placed += 1;
    }

    await client.query("COMMIT");
    return { placed, location };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
