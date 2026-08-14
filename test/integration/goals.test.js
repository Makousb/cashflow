import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { createAccount } from "../../db/queries/accounts.js";
import { getDefaultCategoryId } from "../../db/queries/categories.js";
import { addToGoal, createGoal, getGoal } from "../../db/queries/goals.js";
import { createTransaction } from "../../db/queries/transactions.js";
import { closePool, dropUser, makeUser, one, skipWithoutDb } from "./helpers.js";

// Contributing to a goal used to only increment goals.saved_amount — no
// wallet ever moved, so the same shilling was both spendable and saved. The
// controller now records the contribution as an expense against the chosen
// wallet, the same way a loan payment is; this exercises the query layer
// underneath that (createTransaction + addToGoal), the same two calls the
// controller makes in sequence.
describe("contributing to a goal", { skip: skipWithoutDb }, () => {
  let user;
  let wallet;
  let goal;

  before(async () => {
    user = await makeUser("goal-contrib");
    wallet = await createAccount({ userId: user.id, name: "Savings Wallet", type: "bank" });
    goal = await createGoal({
      userId: user.id, name: "Emergency fund", targetAmount: 50000, targetDate: null
    });
  });

  after(async () => {
    await dropUser(user?.id);
  });

  test("a Savings category exists for it to log against", async () => {
    const id = await getDefaultCategoryId("Savings");
    assert.ok(id, "the default category must exist for both fresh and existing databases");
  });

  test("choosing an account deducts it and logs a Savings expense", async () => {
    const before = Number((await one(
      "SELECT balance FROM accounts WHERE id = $1", [wallet.id]
    )).balance);

    const categoryId = await getDefaultCategoryId("Savings");
    await createTransaction({
      userId: user.id, accountId: wallet.id, categoryId,
      kind: "expense", amount: 5000, note: `Savings: ${goal.name}`, occurredOn: "2026-08-01"
    });
    await addToGoal(goal.id, user.id, 5000);

    const after = Number((await one(
      "SELECT balance FROM accounts WHERE id = $1", [wallet.id]
    )).balance);
    assert.equal(after, before - 5000, "the money actually left the wallet");

    const updatedGoal = await getGoal(goal.id, user.id);
    assert.equal(Number(updatedGoal.saved_amount), 5000);

    const logged = await one(
      "SELECT category_id, kind, note FROM transactions WHERE user_id = $1 AND note LIKE 'Savings:%'",
      [user.id]
    );
    assert.equal(logged.category_id, categoryId);
    assert.equal(logged.kind, "expense");
  });

  test("no account chosen still grows the goal, same as before", async () => {
    const g = await createGoal({
      userId: user.id, name: "No-account goal", targetAmount: 1000, targetDate: null
    });
    const updated = await addToGoal(g.id, user.id, 200);
    assert.equal(Number(updated.saved_amount), 200);

    const rows = await one(
      "SELECT count(*)::int c FROM transactions WHERE user_id = $1 AND note LIKE '%No-account goal%'",
      [user.id]
    );
    assert.equal(rows.c, 0, "with no account chosen, nothing is logged as an expense");
  });

  after(closePool);
});
