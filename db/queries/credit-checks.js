import crypto from "node:crypto";

import { pool } from "../index.js";

// The token is the whole of a lender's authority to look, so it is long, random,
// and never derived from anything about the person it belongs to.
const token = () => crypto.randomBytes(32).toString("base64url");

export async function createCheck({ userId, lender, purpose, amountSought = null, days }) {
  const { rows } = await pool.query(
    `INSERT INTO credit_checks (user_id, token, lender, purpose, amount_sought, expires_on)
     VALUES ($1, $2, $3, $4, $5, CURRENT_DATE + make_interval(days => $6::int))
     RETURNING id, token, lender, purpose, amount_sought,
               to_char(expires_on, 'YYYY-MM-DD') AS expires_on`,
    [userId, token(), lender, purpose, amountSought, days]
  );
  return rows[0];
}

export async function listChecks(userId) {
  const { rows } = await pool.query(
    `SELECT c.id, c.token, c.lender, c.purpose, c.amount_sought,
            to_char(c.expires_on, 'YYYY-MM-DD') AS expires_on,
            c.revoked_at, c.created_at,
            COUNT(v.id)::int AS views,
            MAX(v.viewed_at) AS last_viewed_at
     FROM credit_checks c
     LEFT JOIN credit_check_views v ON v.check_id = c.id
     WHERE c.user_id = $1
     GROUP BY c.id
     ORDER BY c.id DESC`,
    [userId]
  );
  return rows;
}

// By token, for the lender's side. The owner is returned with it because the
// history has to be gathered for them, and nothing else about them is.
export async function getCheckByToken(tokenValue) {
  const { rows } = await pool.query(
    `SELECT id, user_id, lender, purpose, amount_sought,
            to_char(expires_on, 'YYYY-MM-DD') AS expires_on,
            revoked_at, created_at
     FROM credit_checks
     WHERE token = $1`,
    [tokenValue]
  );
  return rows[0] || null;
}

export async function revokeCheck(id, userId) {
  const { rows } = await pool.query(
    `UPDATE credit_checks
     SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [id, userId]
  );
  return rows.length === 1;
}

// Written before the page is built, so a view is recorded even if rendering it
// then goes wrong. Somebody's record of who looked should not depend on the
// looking having gone smoothly.
export async function recordCheckView(checkId) {
  await pool.query(
    "INSERT INTO credit_check_views (check_id) VALUES ($1)",
    [checkId]
  );
}

export async function listCheckViews(checkId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT viewed_at FROM credit_check_views
     WHERE check_id = $1
     ORDER BY viewed_at DESC
     LIMIT $2`,
    [checkId, limit]
  );
  return rows;
}

// The code a lender addresses a request to. Read aloud over a phone or typed off
// a screen, so the alphabet leaves out the characters people confuse: no 0 or O,
// no 1 or I or L, no U.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

function creditCode() {
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `CR-${out}`;
}

// Made on first use rather than at signup, so somebody who never shares anything
// never has one. Retried on the vanishingly unlikely collision instead of
// failing the page it was wanted for.
export async function ensureCreditCode(userId) {
  const { rows } = await pool.query(
    "SELECT credit_code FROM users WHERE id = $1",
    [userId]
  );
  if (rows[0]?.credit_code) return rows[0].credit_code;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = creditCode();
    try {
      const { rows: updated } = await pool.query(
        `UPDATE users SET credit_code = $2
         WHERE id = $1 AND credit_code IS NULL
         RETURNING credit_code`,
        [userId, code]
      );
      if (updated[0]) return updated[0].credit_code;
      // Somebody else's request got there first; theirs is the one to use.
      const { rows: again } = await pool.query(
        "SELECT credit_code FROM users WHERE id = $1",
        [userId]
      );
      if (again[0]?.credit_code) return again[0].credit_code;
    } catch (error) {
      if (error.code !== "23505") throw error;
    }
  }
  throw new Error("could not allocate a credit code");
}

// Codes are typed by hand, so case and stray spaces are forgiven.
export async function findByCreditCode(code) {
  const { rows } = await pool.query(
    "SELECT id, name FROM users WHERE credit_code = $1",
    [String(code || "").trim().toUpperCase()]
  );
  return rows[0] || null;
}

export async function createRequest({ userId, lender, purpose, amountSought = null, reference = null }) {
  const { rows } = await pool.query(
    `INSERT INTO credit_check_requests
       (user_id, token, lender, purpose, amount_sought, reference)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, token, lender, purpose, status`,
    [userId, token(), lender, purpose, amountSought, reference]
  );
  return rows[0];
}

export async function listRequests(userId) {
  const { rows } = await pool.query(
    `SELECT id, lender, purpose, amount_sought, reference, status,
            requested_at, decided_at, check_id
     FROM credit_check_requests
     WHERE user_id = $1
     ORDER BY (status = 'pending') DESC, id DESC`,
    [userId]
  );
  return rows;
}

// By token, for the lender's side, with whatever the answer turned into.
export async function getRequestByToken(tokenValue) {
  const { rows } = await pool.query(
    `SELECT r.id, r.user_id, r.lender, r.purpose, r.amount_sought, r.reference,
            r.status, r.check_id, r.requested_at, r.decided_at,
            c.token AS check_token, c.revoked_at AS check_revoked_at,
            to_char(c.expires_on, 'YYYY-MM-DD') AS check_expires_on
     FROM credit_check_requests r
     LEFT JOIN credit_checks c ON c.id = r.check_id
     WHERE r.token = $1`,
    [tokenValue]
  );
  return rows[0] || null;
}

// Approving is what creates the check. The two go together or neither does: an
// approved request pointing at no check would show the lender nothing and tell
// the person they had shared something.
export async function approveRequest({ requestId, userId, days }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: claimed } = await client.query(
      `UPDATE credit_check_requests
       SET status = 'approved', decided_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'pending'
       RETURNING lender, purpose, amount_sought`,
      [requestId, userId]
    );
    if (claimed.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const ask = claimed[0];
    const { rows: made } = await client.query(
      `INSERT INTO credit_checks (user_id, token, lender, purpose, amount_sought, expires_on)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE + make_interval(days => $6::int))
       RETURNING id, token, to_char(expires_on, 'YYYY-MM-DD') AS expires_on`,
      [userId, token(), ask.lender, ask.purpose, ask.amount_sought, days]
    );

    await client.query(
      "UPDATE credit_check_requests SET check_id = $2 WHERE id = $1",
      [requestId, made[0].id]
    );

    await client.query("COMMIT");
    return { ...made[0], lender: ask.lender };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function denyRequest(requestId, userId) {
  const { rows } = await pool.query(
    `UPDATE credit_check_requests
     SET status = 'denied', decided_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'pending'
     RETURNING id`,
    [requestId, userId]
  );
  return rows.length === 1;
}

// Take the right to tell somebody one ask has arrived. Exactly one caller gets
// it, and a send that fails hands it back so the next attempt tries again.
export async function claimRequestNotice(requestId) {
  const { rowCount } = await pool.query(
    `UPDATE credit_check_requests
     SET notified_at = NOW()
     WHERE id = $1 AND notified_at IS NULL`,
    [requestId]
  );
  return rowCount === 1;
}

export async function releaseRequestNotice(requestId) {
  await pool.query(
    "UPDATE credit_check_requests SET notified_at = NULL WHERE id = $1",
    [requestId]
  );
}

// Asks still waiting that nobody has been told about — what a retry sweeps up.
export async function unnotifiedRequests(userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, token, lender, purpose, amount_sought, reference, requested_at
     FROM credit_check_requests
     WHERE user_id = $1 AND status = 'pending' AND notified_at IS NULL
     ORDER BY id`,
    [userId]
  );
  return rows;
}

export async function getRequest(id) {
  const { rows } = await pool.query(
    `SELECT id, user_id, token, lender, purpose, amount_sought, reference, requested_at
     FROM credit_check_requests WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}
