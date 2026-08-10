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
