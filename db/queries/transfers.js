import { pool } from "../index.js";
import { notYours, ownedAccountId } from "./transactions.js";

// One user's own money moving from one wallet to another — not a purchase
// and not income, so it must never look like either to a total that adds
// up kind='expense' or kind='income'. Two ordinary transactions rows carry
// the actual balance effect (kind='transfer' on both, invisible to every
// existing exact-match total); this row is what makes "which two rows are
// one move" and "what were its two ends" answerable directly rather than
// re-derived.
export async function createTransfer({
  userId,
  fromAccountId,
  toAccountId,
  amount,
  note,
  occurredOn
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const from = await ownedAccountId(client, fromAccountId, userId);
    const to = await ownedAccountId(client, toAccountId, userId);
    if (!from || !to) {
      throw notYours("wallet");
    }
    if (from === to) {
      const refusal = new Error("Pick two different wallets to transfer between.");
      refusal.code = "NOT_YOURS";
      throw refusal;
    }

    const { rows } = await client.query(
      `INSERT INTO transfers (user_id, from_account_id, to_account_id, amount, note, occurred_on)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, from, to, amount, note, occurredOn]
    );
    const transfer = rows[0];

    await client.query(
      `INSERT INTO transactions (user_id, account_id, kind, amount, note, occurred_on, source, transfer_id)
       VALUES ($1, $2, 'transfer', $3, $4, $5, 'transfer', $6)`,
      [userId, from, amount, note, occurredOn, transfer.id]
    );
    await client.query(
      `INSERT INTO transactions (user_id, account_id, kind, amount, note, occurred_on, source, transfer_id)
       VALUES ($1, $2, 'transfer', $3, $4, $5, 'transfer', $6)`,
      [userId, to, amount, note, occurredOn, transfer.id]
    );

    await client.query(
      "UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3",
      [amount, from, userId]
    );
    await client.query(
      "UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3",
      [amount, to, userId]
    );

    await client.query("COMMIT");
    return transfer;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// The transfers row already holds the amount and both ends, so there is no
// need to read the two transaction legs back before reversing their
// balance effect — only to remove them, which DELETE ... CASCADE (see
// transactions.transfer_id in db/ensureSchema.js) does in the same
// statement as removing this row.
export async function deleteTransfer(id, userId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT * FROM transfers WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [id, userId]
    );
    const transfer = rows[0];
    if (!transfer) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      "UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3",
      [transfer.amount, transfer.from_account_id, userId]
    );
    await client.query(
      "UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND user_id = $3",
      [transfer.amount, transfer.to_account_id, userId]
    );

    await client.query(
      "DELETE FROM transfers WHERE id = $1 AND user_id = $2",
      [id, userId]
    );

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
