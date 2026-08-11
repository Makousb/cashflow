import { pool } from "../index.js";

// Storage for the card agent. What the agent thinks is computed in
// utils/card-agent.js from rows fetched through db/queries/credit.js; this
// keeps only the standing instructions, the record of what it has said, and the
// one thing that must not happen twice — a statement paid by itself.

// What the agent may do. Absent means it has never been configured, and the
// caller reads that as "watch and advise, act on nothing", which is what an
// agent nobody has switched on should do.
export async function getAgentSettings(userId) {
  const { rows } = await pool.query(
    `SELECT user_id, autopay, autopay_account_id, lead_days, utilisation_target,
            charge_guard, alert_email,
            to_char(last_run_on, 'YYYY-MM-DD') AS last_run_on
     FROM card_agent_settings
     WHERE user_id = $1`,
    [userId]
  );
  return rows[0] || null;
}

export async function saveAgentSettings({
  userId, autopay, autopayAccountId, leadDays, utilisationTarget, chargeGuard, alertEmail
}) {
  const { rows } = await pool.query(
    `INSERT INTO card_agent_settings
       (user_id, autopay, autopay_account_id, lead_days, utilisation_target,
        charge_guard, alert_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id) DO UPDATE SET
       autopay = EXCLUDED.autopay,
       autopay_account_id = EXCLUDED.autopay_account_id,
       lead_days = EXCLUDED.lead_days,
       utilisation_target = EXCLUDED.utilisation_target,
       charge_guard = EXCLUDED.charge_guard,
       alert_email = EXCLUDED.alert_email
     RETURNING *`,
    [userId, autopay, autopayAccountId, leadDays, utilisationTarget, chargeGuard, alertEmail]
  );
  return rows[0];
}

// Claim today's watch, atomically. The UPDATE only matches if today has not been
// claimed, so whichever page load gets there first runs the agent and every
// other one is told no. Without this, two tabs opened together would each see
// "not run today" and each go and pay a card.
//
// The row is created if it is missing, so somebody who has never opened the
// settings still gets a daily watch — it just has nothing it is allowed to do.
export async function claimDailyRun(userId) {
  const { rowCount } = await pool.query(
    `INSERT INTO card_agent_settings (user_id, last_run_on)
     VALUES ($1, CURRENT_DATE)
     ON CONFLICT (user_id) DO UPDATE SET last_run_on = CURRENT_DATE
     WHERE card_agent_settings.last_run_on IS NULL
        OR card_agent_settings.last_run_on < CURRENT_DATE`,
    [userId]
  );
  return rowCount === 1;
}

// Hand the day back so a failed watch is tried again rather than silently
// skipped until tomorrow.
export async function releaseDailyRun(userId, previous) {
  await pool.query(
    "UPDATE card_agent_settings SET last_run_on = $2 WHERE user_id = $1",
    [userId, previous]
  );
}

export async function saveRun({
  userId, score, utilisation, balance, points, counts, narrative, mode, moves, actions
}) {
  const { rows } = await pool.query(
    `INSERT INTO card_agent_runs
       (user_id, score, utilisation, balance, points, moves_total, moves_high,
        narrative, mode, moves, actions)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
     RETURNING *`,
    [userId, score, utilisation, balance, points, counts.total, counts.high,
      narrative, mode, JSON.stringify(moves), JSON.stringify(actions)]
  );
  return rows[0];
}

export async function listRuns(userId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT id, score, utilisation, balance, points, moves_total, moves_high,
            mode, notified_to, notified_at, created_at
     FROM card_agent_runs
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

export async function getRun(id, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM card_agent_runs WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rows[0] || null;
}

export async function recordRunNotification(runId, to) {
  const { rows } = await pool.query(
    `UPDATE card_agent_runs SET notified_to = $2, notified_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [runId, to]
  );
  return rows[0] || null;
}

// Take the right to pay one statement by machine. Exactly one caller gets it:
// the unique key on (facility, cycle) settles a race in the database rather than
// in whichever request happened to read the balance first. This is somebody's
// money, so the claim is taken before the payment is made, not after.
export async function claimAgentPayment({ facilityId, userId, cycle, kind }) {
  const { rows } = await pool.query(
    `INSERT INTO card_agent_payments (facility_id, user_id, cycle, kind)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (facility_id, cycle) DO NOTHING
     RETURNING id`,
    [facilityId, userId, cycle, kind]
  );
  return rows[0]?.id || null;
}

// Hand the claim back when the payment did not happen, so the next watch tries
// again instead of recording a cycle as paid that was not.
export async function releaseAgentPayment(id) {
  await pool.query("DELETE FROM card_agent_payments WHERE id = $1", [id]);
}

export async function completeAgentPayment({ id, paymentId, amount }) {
  const { rows } = await pool.query(
    `UPDATE card_agent_payments SET payment_id = $2, amount = $3
     WHERE id = $1
     RETURNING *`,
    [id, paymentId, amount]
  );
  return rows[0] || null;
}

export async function listAgentPayments(userId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT p.id, p.facility_id, p.cycle, p.kind, p.amount, p.payment_id,
            p.created_at, f.label
     FROM card_agent_payments p
     LEFT JOIN credit_facilities f ON f.id = p.facility_id
     WHERE p.user_id = $1 AND p.payment_id IS NOT NULL
     ORDER BY p.id DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

// --- Points ---

export async function listRedemptions(userId) {
  const { rows } = await pool.query(
    `SELECT id, facility_id, points, amount, payment_id,
            to_char(redeemed_on, 'YYYY-MM-DD') AS redeemed_on
     FROM credit_redemptions
     WHERE user_id = $1
     ORDER BY id DESC`,
    [userId]
  );
  return rows;
}

export async function addRedemption({ facilityId, userId, points, amount, paymentId, redeemedOn }) {
  const { rows } = await pool.query(
    `INSERT INTO credit_redemptions
       (facility_id, user_id, points, amount, payment_id, redeemed_on)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [facilityId, userId, points, amount, paymentId, redeemedOn]
  );
  return rows[0];
}
