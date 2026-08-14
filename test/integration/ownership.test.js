import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  createTransaction,
  deleteTransaction,
  listRecentTransactions
} from "../../db/queries/transactions.js";
import { createRecurring } from "../../db/queries/recurring.js";
import { upsertBudget } from "../../db/queries/budgets.js";
import { createAccount } from "../../db/queries/accounts.js";
import { closePool, dropUser, makeUser, one, q, skipWithoutDb } from "./helpers.js";

// An id off a form is an id anybody can type. The foreign keys behind these
// tables only ask that the row exists, never whose it is, so the check has to
// be made in the query layer — and this file is the proof that it is.
describe("a wallet or category belonging to somebody else", { skip: skipWithoutDb }, () => {
  let victim;
  let attacker;
  let victimWallet;
  let victimCategory;
  let ownWallet;

  before(async () => {
    victim = await makeUser("owns");
    attacker = await makeUser("takes");
    victimWallet = await createAccount({
      userId: victim.id, name: "Victim Savings", type: "bank"
    });
    victimCategory = await one(
      `INSERT INTO categories (user_id, name, kind, icon)
       VALUES ($1, 'Private Category', 'expense', '🤫') RETURNING *`,
      [victim.id]
    );
    ownWallet = await createAccount({
      userId: attacker.id, name: "Own Cash", type: "cash"
    });

    await createTransaction({
      userId: victim.id, accountId: victimWallet.id, categoryId: null,
      kind: "income", amount: 100000, note: "Salary", occurredOn: "2026-08-01"
    });
  });

  after(async () => {
    await dropUser(victim?.id);
    await dropUser(attacker?.id);
  });

  const balanceOf = async (id) =>
    Number((await one("SELECT balance FROM accounts WHERE id = $1", [id])).balance);

  test("cannot be named on a transaction", async () => {
    await assert.rejects(
      () => createTransaction({
        userId: attacker.id, accountId: victimWallet.id, categoryId: null,
        kind: "expense", amount: 50000, note: "ATTACK", occurredOn: "2026-08-02"
      }),
      (error) => error.code === "NOT_YOURS",
      "a wallet that is not yours must be refused, not recorded"
    );

    const rows = await q(
      "SELECT id FROM transactions WHERE user_id = $1", [attacker.id]
    );
    assert.equal(rows.length, 0, "the refused transaction must not have been written");
  });

  test("so their balance cannot be moved by deleting one", async () => {
    // The whole point. Creating scoped its balance update by owner, deleting
    // did not — so the attack was to attach a transaction to somebody else's
    // wallet and then delete it, and the reversal landed on their balance.
    assert.equal(await balanceOf(victimWallet.id), 100000);
  });

  test("and their category cannot be borrowed to read its name", async () => {
    await assert.rejects(
      () => createTransaction({
        userId: attacker.id, accountId: null, categoryId: victimCategory.id,
        kind: "expense", amount: 10, note: "CATPROBE", occurredOn: "2026-08-02"
      }),
      (error) => error.code === "NOT_YOURS"
    );

    const listed = await listRecentTransactions(attacker.id);
    assert.equal(
      listed.some((t) => t.category_name === "Private Category"), false,
      "somebody else's category name must never reach this page"
    );
  });

  test("nor stored on a recurring rule to be spent later", async () => {
    await assert.rejects(
      () => createRecurring({
        userId: attacker.id, accountId: victimWallet.id, categoryId: null,
        kind: "expense", amount: 100, note: "later", frequency: "monthly",
        nextRun: "2026-09-01"
      }),
      (error) => error.code === "NOT_YOURS",
      "a rule is stored now and spent later — refusing at materialize time " +
      "would fail on a page load instead of on the form that set it"
    );
  });

  test("nor budgeted against", async () => {
    await assert.rejects(
      () => upsertBudget({
        userId: attacker.id, categoryId: victimCategory.id,
        month: "2026-08-01", amount: 500
      }),
      (error) => error.code === "NOT_YOURS"
    );
  });

  test("while your own wallet still works exactly as before", async () => {
    const created = await createTransaction({
      userId: attacker.id, accountId: ownWallet.id, categoryId: null,
      kind: "income", amount: 4000, note: "Wages", occurredOn: "2026-08-03"
    });
    assert.equal(await balanceOf(ownWallet.id), 4000);

    await deleteTransaction(created.id, attacker.id);
    assert.equal(await balanceOf(ownWallet.id), 0, "deleting reverses it again");
  });

  test("and a built-in category is everybody's", async () => {
    const builtin = await one(
      "SELECT id FROM categories WHERE user_id IS NULL LIMIT 1"
    );
    const created = await createTransaction({
      userId: attacker.id, accountId: null, categoryId: builtin.id,
      kind: "expense", amount: 20, note: "Shared", occurredOn: "2026-08-04"
    });
    assert.equal(created.category_id, builtin.id);
  });

  after(closePool);
});
