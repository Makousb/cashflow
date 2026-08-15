import { pool } from "../index.js";

export async function listAccounts(userId) {
  const { rows } = await pool.query(
    "SELECT * FROM accounts WHERE user_id = $1 ORDER BY created_at",
    [userId]
  );
  return rows;
}

export async function createAccount({ userId, name, type }) {
  const { rows } = await pool.query(
    `INSERT INTO accounts (user_id, name, type)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userId, name, type]
  );
  return rows[0];
}

export async function findAccountByMonoId(monoAccountId) {
  const { rows } = await pool.query(
    "SELECT * FROM accounts WHERE mono_account_id = $1",
    [monoAccountId]
  );
  return rows[0] || null;
}

// Webhooks are delivered at-least-once, so a replayed account_connected event
// must not create a second wallet for the same linked account — ON CONFLICT
// on the unique mono_account_id makes the second delivery a no-op update
// rather than a duplicate row.
export async function upsertMonoAccount({
  userId,
  ref,
  monoAccountId,
  institutionName,
  accountNumberMask
}) {
  const { rows } = await pool.query(
    `INSERT INTO accounts (user_id, name, type, mono_account_id, mono_link_ref, institution_name, account_number_mask)
     VALUES ($1, $2, 'bank', $3, $4, $5, $6)
     ON CONFLICT (mono_account_id) DO UPDATE
       SET institution_name = EXCLUDED.institution_name,
           account_number_mask = EXCLUDED.account_number_mask
     RETURNING *`,
    [
      userId,
      institutionName || "Linked bank account",
      monoAccountId,
      ref,
      institutionName,
      accountNumberMask
    ]
  );
  return rows[0];
}

export async function listMonoLinkedAccounts(userId) {
  const { rows } = await pool.query(
    "SELECT * FROM accounts WHERE user_id = $1 AND mono_account_id IS NOT NULL",
    [userId]
  );
  return rows;
}

export async function touchMonoSync(accountId) {
  await pool.query(
    "UPDATE accounts SET mono_synced_at = NOW() WHERE id = $1",
    [accountId]
  );
}
