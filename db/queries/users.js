import { pool } from "../index.js";
import { DEFAULT_CURRENCY } from "../../utils/currencies.js";

export async function findUserByEmail(email) {
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [
    email
  ]);
  return rows[0] || null;
}

export async function createUser({
  name,
  email,
  passwordHash,
  currency = DEFAULT_CURRENCY,
  accountType = "personal"
}) {
  // A new account's stored amounts live in the currency chosen at signup, so
  // base and display start the same.
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, currency, base_currency, account_type)
     VALUES ($1, $2, $3, $4, $4, $5)
     RETURNING id, name, email, currency, base_currency, account_type`,
    [name, email, passwordHash, currency, accountType]
  );
  return rows[0];
}

export async function updateUserCurrency(userId, currency) {
  const { rows } = await pool.query(
    `UPDATE users SET currency = $1 WHERE id = $2
     RETURNING id, name, email, currency, base_currency, account_type`,
    [currency, userId]
  );
  return rows[0] || null;
}

// Just the name. Used when a lender opens a credit check the person gave them:
// they need to know whose history they are looking at, and nothing else about
// the person is theirs to see.
export async function getUserName(id) {
  const { rows } = await pool.query("SELECT name FROM users WHERE id = $1", [id]);
  return rows[0]?.name || null;
}

// Name, address and currency, for writing to somebody about their own account.
export async function getUserContact(id) {
  const { rows } = await pool.query(
    "SELECT name, email, currency, base_currency FROM users WHERE id = $1",
    [id]
  );
  return rows[0] || null;
}
