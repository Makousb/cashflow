// Shared setup for tests that need a real PostgreSQL. Each test file builds its
// own user and tears it down again; everything else cascades from that row, so
// the tests never see each other's data and never leave any behind.
//
// Without a database these files skip rather than fail, so `npm test` still
// works on a machine that has only checked the repo out. Skipping is decided by
// the environment alone — see below — and never by how a connection went.

import path from "node:path";

import { pool } from "../../db/index.js";
import { ensureSchemaState } from "../../db/ensureSchema.js";
import { ensureChart } from "../../db/queries/ledger.js";

// Anything here means someone has pointed this checkout at a database, so these
// tests are expected to run and failing to reach it is a failure. DB_SSL is not
// on the list: it qualifies a connection rather than naming one.
const DB_ENV_VARS = [
  "DATABASE_URL", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"
];
const configuredBy = DB_ENV_VARS.filter((name) => process.env[name]);

// A CI job with no database configured is a broken workflow, not a laptop, and
// silently passing is the one thing it must not do.
const maySkip = configuredBy.length === 0 && !process.env.CI;

// A first connection to a database that has just been created is slow — it may
// still be starting, and the pool pays for TLS and authentication before the
// query is even sent — so one attempt against one short deadline decides
// nothing. Four seconds of it used to lose the race on a cold database and skip
// a whole file. The deadline covers building the schema as well, which is why
// it is a long way from anything legitimate rather than a close-run thing.
//
// Retrying is for a database that is expected and may still be coming up; when
// nothing names one, a second look will not conjure it.
const ATTEMPTS = maySkip ? 1 : 3;
const ATTEMPT_TIMEOUT_MS = 30_000;
const PAUSE_MS = 1_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    // A deadline that has already been beaten must not hold the process open.
    timer.unref?.();
  });

  // The loser of the race still settles; without this its rejection is unhandled.
  promise.catch(() => {});
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

// Asks ensureSchema what state the database is in, retrying only the answer
// that a retry can change. "unreachable" is worth another go on a database that
// may still be coming up; "schema" is a bug in the SQL and will say the same
// thing three times.
async function reachDatabase() {
  let last = { ok: false, reason: "unreachable", detail: "no attempt made" };

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      last = await withTimeout(ensureSchemaState(), ATTEMPT_TIMEOUT_MS);
    } catch (error) {
      last = { ok: false, reason: "unreachable", detail: error.message };
    }

    if (last.ok || last.reason === "schema") {
      return last;
    }

    if (attempt < ATTEMPTS) {
      console.warn(
        `Database attempt ${attempt}/${ATTEMPTS} failed (${last.detail}) — retrying.`
      );
      await sleep(PAUSE_MS * attempt);
    }
  }

  return last;
}

async function connect() {
  const state = await reachDatabase();

  if (state.ok) {
    return true;
  }

  // From here a failure is a real one and must not be reported as an absent
  // database: that once left CI green while two thirds of these tests silently
  // skipped. ensureSchema reports rather than throws, so an explicit throw is
  // the only way to make the problem visible.
  if (state.reason === "schema") {
    throw new Error(
      "The database is reachable but its schema could not be created. " +
      "These tests are being skipped for a reason that is not 'no database'.\n" +
      `  ${state.detail}`
    );
  }

  if (!maySkip) {
    throw new Error(
      `The database could not be reached after ${ATTEMPTS} attempts.\n` +
      `  last failure: ${state.detail}\n` +
      (configuredBy.length > 0
        ? `  configured by: ${configuredBy.join(", ")}\n`
        : "  running on CI, where a database is required\n") +
      "  This is a failure, not an absent database: the environment names a " +
      "database, so these tests must run against it rather than skip."
    );
  }

  return false;
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

// Raw SQL rather than createBusiness, so the fixture stays independent of what
// that function happens to do — but the chart of accounts is opened all the
// same, because a business the app made always has one and a fixture that
// differs is testing something the app never sees.
export async function makeBusiness(userId, name, extra = {}) {
  const business = await one(
    `INSERT INTO businesses (user_id, name, industry, is_supplier, lead_time_days, supply_code)
     VALUES ($1, $2, 'Retail', $3, $4,
             'TEST-' || substr(md5(random()::text), 1, 8))
     RETURNING *`,
    [userId, name, extra.isSupplier || false, extra.leadTimeDays || 3]
  );
  await ensureChart(business.id, userId);
  return business;
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

// A skipped file leaves no mark on the run's totals — node has reported
// `# skipped 0` for a run in which every test in this file was skipped — so it
// says so itself, on the way past, where it cannot be mistaken for a pass.
if (!dbReady) {
  const file = path.basename(process.argv[1] || "this file");
  console.warn(
    `\n  !! ${file}: EVERY test in this file is being SKIPPED — no database is ` +
    "configured.\n" +
    "     Nothing in the totals below will say so. Set DATABASE_URL or the " +
    "DB_* variables to run them.\n"
  );
}
