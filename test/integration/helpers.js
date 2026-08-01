// Shared setup for tests that need a real PostgreSQL. Each test file builds its
// own user and tears it down again; everything else cascades from that row, so
// the tests never see each other's data and never leave any behind.
//
// Without a database these files skip rather than fail, so `npm test` still
// works on a machine that has only checked the repo out.

import { pool } from "../../db/index.js";
import { ensureSchema } from "../../db/ensureSchema.js";

async function connect() {
  try {
    // Don't sit waiting on a host that isn't there.
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), 4000)
      )
    ]);
  } catch {
    // Genuinely no database — the suites skip.
    return false;
  }

  // From here a failure is a real one and must not be reported as an absent
  // database: that once left CI green while two thirds of these tests silently
  // skipped. ensureSchema swallows its own errors, so an explicit throw is the
  // only way to make the problem visible.
  if (!(await ensureSchema())) {
    throw new Error(
      "The database is reachable but its schema could not be created. " +
      "These tests are being skipped for a reason that is not 'no database'."
    );
  }
  return true;
}

export const dbReady = await connect();

export const skipWithoutDb = dbReady
  ? undefined
  : "needs PostgreSQL — set DATABASE_URL or the DB_* variables";

export const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
export const one = async (sql, params = []) => (await q(sql, params))[0];

// A throwaway user. Deleting it cascades away every row these tests create.
export async function makeUser(label) {
  const email = `test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const user = await one(
    `INSERT INTO users (name, email, password_hash, currency, base_currency)
     VALUES ('Test User', $1, 'not-a-real-hash', 'KES', 'KES')
     RETURNING id, currency, base_currency`,
    [email]
  );
  return user;
}

export async function makeBusiness(userId, name, extra = {}) {
  return one(
    `INSERT INTO businesses (user_id, name, industry, is_supplier, lead_time_days, supply_code)
     VALUES ($1, $2, 'Retail', $3, $4,
             'TEST-' || substr(md5(random()::text), 1, 8))
     RETURNING *`,
    [userId, name, extra.isSupplier || false, extra.leadTimeDays || 3]
  );
}

export async function makeProduct(businessId, userId, product) {
  return one(
    `INSERT INTO products
       (business_id, user_id, name, sku, quantity, unit_cost, sale_price,
        reorder_point, reorder_qty)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [businessId, userId, product.name, product.sku || null, product.quantity,
     product.unitCost, product.salePrice, product.reorderPoint || 0,
     product.reorderQty || 0]
  );
}

export async function dropUser(userId) {
  if (userId) {
    await q("DELETE FROM users WHERE id = $1", [userId]);
  }
}

export async function closePool() {
  await pool.end();
}

export const stockOf = async (productId) =>
  Number((await one("SELECT quantity FROM products WHERE id = $1", [productId])).quantity);
