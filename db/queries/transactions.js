import { pool } from "../index.js";

export async function listRecentTransactions(userId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT t.*,
            -- A date input's value needs YYYY-MM-DD; occurred_on is a DATE
            -- column and pg hands those back as local-midnight Date objects,
            -- so building the string here avoids a caller reaching for
            -- toISOString and shifting the day for anyone east of UTC.
            to_char(t.occurred_on, 'YYYY-MM-DD') AS occurred_on_iso,
            c.name AS category_name,
            c.icon AS category_icon,
            a.name AS account_name
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     LEFT JOIN accounts a ON a.id = t.account_id
     WHERE t.user_id = $1
     ORDER BY t.occurred_on DESC, t.id DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

// A wallet and a category reach this function as ids off a form, and a form
// can be edited before it is sent. The foreign keys do not help: they ask only
// that the row exists, never whose it is. An id belonging to somebody else
// therefore inserted happily, showed that person's wallet name back on this
// page, and — because deleting a transaction reverses its amount against
// whatever account_id it carries — moved their balance on the way out.
//
// Resolving both against the owner is what stops it, and it belongs here
// rather than in each controller because every path that records personal
// money comes through this one function: a transaction typed in by hand, a
// confirmed receipt, a loan or card repayment, a matured recurring rule.
//
// Refusing rather than quietly filing it under "no wallet" is deliberate. The
// forms only ever offer what the person owns, so nothing legitimate can reach
// this — and a money app that silently records something other than what it
// was told is worse than one that says no.
export function notYours(what) {
  const refusal = new Error(
    `That ${what} is not one of yours. Pick one from the list and try again.`
  );
  // Marked like the ledger's closed-period refusal: somebody being told no,
  // not something going wrong, so it reaches them as a message rather than a
  // 500. See middlewares/error.middleware.js.
  refusal.code = "NOT_YOURS";
  return refusal;
}

// `db` is the pool or an already-open client: a recurring rule is checked on
// its own, a transaction inside the block that writes it.
export async function ownedAccountId(db, accountId, userId) {
  if (accountId === null || accountId === undefined || accountId === "") {
    return null;
  }

  const id = Number(accountId);
  if (!Number.isInteger(id)) {
    throw notYours("wallet");
  }

  const { rowCount } = await db.query(
    "SELECT 1 FROM accounts WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  if (rowCount === 0) {
    throw notYours("wallet");
  }
  return id;
}

// Built-in categories are shared by everyone and carry no user_id, so "yours"
// means your own or one of those.
export async function ownedCategoryId(db, categoryId, userId) {
  if (categoryId === null || categoryId === undefined || categoryId === "") {
    return null;
  }

  const id = Number(categoryId);
  if (!Number.isInteger(id)) {
    throw notYours("category");
  }

  const { rowCount } = await db.query(
    "SELECT 1 FROM categories WHERE id = $1 AND (user_id IS NULL OR user_id = $2)",
    [id, userId]
  );
  if (rowCount === 0) {
    throw notYours("category");
  }
  return id;
}

// Inserting a transaction and adjusting the wallet balance must succeed or
// fail together, hence the explicit transaction block.
export async function createTransaction({
  userId,
  accountId,
  categoryId,
  kind,
  amount,
  note,
  occurredOn
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const ownedAccount = await ownedAccountId(client, accountId, userId);
    const ownedCategory = await ownedCategoryId(client, categoryId, userId);

    const { rows } = await client.query(
      `INSERT INTO transactions (user_id, account_id, category_id, kind, amount, note, occurred_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [userId, ownedAccount, ownedCategory, kind, amount, note, occurredOn]
    );

    if (ownedAccount) {
      const delta = kind === "income" ? amount : -amount;
      await client.query(
        "UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3",
        [delta, ownedAccount, userId]
      );
    }

    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getTransaction(id, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM transactions WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rows[0] || null;
}

// Until now a mistake could only be deleted and re-entered, which loses
// nothing but is friction for a typo. Editing has to undo the old row's
// effect on whatever wallet it touched and apply the new one — possibly a
// different wallet, or none at all either side — inside one transaction so a
// crash between the two never leaves a balance half-adjusted.
//
// Locked with FOR UPDATE rather than read-then-write: two edits racing on the
// same row would otherwise both read the pre-edit balance and the second
// UPDATE's delta would land on top of a balance the first edit already moved,
// silently losing one of the two adjustments.
export async function updateTransaction({
  id,
  userId,
  accountId,
  categoryId,
  kind,
  amount,
  note,
  occurredOn
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows: existingRows } = await client.query(
      "SELECT * FROM transactions WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [id, userId]
    );
    const existing = existingRows[0];
    if (!existing) {
      await client.query("ROLLBACK");
      return null;
    }

    const ownedAccount = await ownedAccountId(client, accountId, userId);
    const ownedCategory = await ownedCategoryId(client, categoryId, userId);

    if (existing.account_id) {
      const oldAmount = Number(existing.amount);
      const reversal = existing.kind === "income" ? -oldAmount : oldAmount;
      await client.query(
        "UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3",
        [reversal, existing.account_id, userId]
      );
    }

    const { rows } = await client.query(
      `UPDATE transactions
       SET account_id = $1, category_id = $2, kind = $3, amount = $4,
           note = $5, occurred_on = $6
       WHERE id = $7 AND user_id = $8
       RETURNING *`,
      [ownedAccount, ownedCategory, kind, amount, note, occurredOn, id, userId]
    );

    if (ownedAccount) {
      const delta = kind === "income" ? amount : -amount;
      await client.query(
        "UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3",
        [delta, ownedAccount, userId]
      );
    }

    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteTransaction(id, userId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `DELETE FROM transactions
       WHERE id = $1 AND user_id = $2
       RETURNING account_id, kind, amount`,
      [id, userId]
    );

    const removed = rows[0];

    if (removed && removed.account_id) {
      const amount = Number(removed.amount);
      const delta = removed.kind === "income" ? -amount : amount;
      // Scoped by owner like the insert above. Every account_id written from
      // now on belongs to this user, so the clause changes nothing for them —
      // it is here so that a row left over from before this was enforced
      // cannot reverse itself against a stranger's wallet.
      await client.query(
        "UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND user_id = $3",
        [delta, removed.account_id, userId]
      );
    }

    await client.query("COMMIT");
    return Boolean(removed);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Slim rows for the Python analytics service: numbers as floats, dates as
// ISO strings, category names resolved.
export async function listTransactionsForAnalytics(userId, months = 6) {
  const { rows } = await pool.query(
    `SELECT t.kind,
            t.amount::float AS amount,
            to_char(t.occurred_on, 'YYYY-MM-DD') AS occurred_on,
            COALESCE(c.name, 'Uncategorized') AS category,
            COALESCE(c.icon, '🧾') AS icon
     FROM transactions t
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.user_id = $1
       AND t.occurred_on >= date_trunc('month', CURRENT_DATE) - make_interval(months => $2)
     ORDER BY t.occurred_on`,
    [userId, months - 1]
  );
  return rows;
}

export async function getMonthlySummary(userId, monthStart) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE kind = 'income'), 0) AS income,
       COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0) AS expenses
     FROM transactions
     WHERE user_id = $1
       AND occurred_on >= $2
       AND occurred_on < $2::date + INTERVAL '1 month'`,
    [userId, monthStart]
  );
  return rows[0];
}
