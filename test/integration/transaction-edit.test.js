import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { createAccount } from "../../db/queries/accounts.js";
import {
  createTransaction,
  getTransaction,
  updateTransaction
} from "../../db/queries/transactions.js";
import { closePool, dropUser, makeUser, one, skipWithoutDb } from "./helpers.js";

// Until this, a mistake could only be deleted and re-entered. Editing has to
// undo the old row's effect on whatever wallet it touched and apply the new
// one — possibly a different wallet, or none at all either side.
describe("editing a transaction", { skip: skipWithoutDb }, () => {
  let user;
  let walletA;
  let walletB;

  before(async () => {
    user = await makeUser("edit-tx");
    walletA = await createAccount({ userId: user.id, name: "Wallet A", type: "cash" });
    walletB = await createAccount({ userId: user.id, name: "Wallet B", type: "bank" });
  });

  after(async () => {
    await dropUser(user?.id);
  });

  const balanceOf = async (id) =>
    Number((await one("SELECT balance FROM accounts WHERE id = $1", [id])).balance);

  test("changing the amount adjusts the same wallet by the difference", async () => {
    const tx = await createTransaction({
      userId: user.id, accountId: walletA.id, categoryId: null,
      kind: "expense", amount: 100, note: "Lunch", occurredOn: "2026-08-01"
    });
    assert.equal(await balanceOf(walletA.id), -100);

    await updateTransaction({
      id: tx.id, userId: user.id, accountId: walletA.id, categoryId: null,
      kind: "expense", amount: 150, note: "Lunch", occurredOn: "2026-08-01"
    });
    assert.equal(await balanceOf(walletA.id), -150, "the old 100 is reversed, the new 150 applied");
  });

  test("moving it to a different wallet reverses the old and charges the new", async () => {
    const tx = await createTransaction({
      userId: user.id, accountId: walletA.id, categoryId: null,
      kind: "expense", amount: 200, note: "Fuel", occurredOn: "2026-08-02"
    });
    const beforeA = await balanceOf(walletA.id);
    const beforeB = await balanceOf(walletB.id);

    await updateTransaction({
      id: tx.id, userId: user.id, accountId: walletB.id, categoryId: null,
      kind: "expense", amount: 200, note: "Fuel", occurredOn: "2026-08-02"
    });

    assert.equal(await balanceOf(walletA.id), beforeA + 200, "wallet A gets its 200 back");
    assert.equal(await balanceOf(walletB.id), beforeB - 200, "wallet B is now charged");
  });

  test("flipping expense to income reverses in one direction and applies in the other", async () => {
    const tx = await createTransaction({
      userId: user.id, accountId: walletA.id, categoryId: null,
      kind: "expense", amount: 50, note: "Refund pending", occurredOn: "2026-08-03"
    });
    const before = await balanceOf(walletA.id);

    await updateTransaction({
      id: tx.id, userId: user.id, accountId: walletA.id, categoryId: null,
      kind: "income", amount: 50, note: "Refund pending", occurredOn: "2026-08-03"
    });

    // Reversing a 50 expense gives back 50; applying a 50 income adds another
    // 50 — a swing of 100 on the same wallet from one edit.
    assert.equal(await balanceOf(walletA.id), before + 100);
    const stored = await getTransaction(tx.id, user.id);
    assert.equal(stored.kind, "income");
  });

  test("removing the account on edit reverses it and touches nothing further", async () => {
    const tx = await createTransaction({
      userId: user.id, accountId: walletA.id, categoryId: null,
      kind: "expense", amount: 75, note: "Misc", occurredOn: "2026-08-04"
    });
    const before = await balanceOf(walletA.id);

    await updateTransaction({
      id: tx.id, userId: user.id, accountId: null, categoryId: null,
      kind: "expense", amount: 75, note: "Misc", occurredOn: "2026-08-04"
    });

    assert.equal(await balanceOf(walletA.id), before + 75);
    const stored = await getTransaction(tx.id, user.id);
    assert.equal(stored.account_id, null);
  });

  test("still refuses a wallet or category that is not yours", async () => {
    const stranger = await makeUser("edit-tx-stranger");
    const strangerWallet = await createAccount({
      userId: stranger.id, name: "Stranger's", type: "cash"
    });

    try {
      const tx = await createTransaction({
        userId: user.id, accountId: walletA.id, categoryId: null,
        kind: "expense", amount: 40, note: "Snack", occurredOn: "2026-08-05"
      });

      await assert.rejects(
        () => updateTransaction({
          id: tx.id, userId: user.id, accountId: strangerWallet.id, categoryId: null,
          kind: "expense", amount: 40, note: "Snack", occurredOn: "2026-08-05"
        }),
        (error) => error.code === "NOT_YOURS"
      );

      // And the refused edit must not have touched either wallet.
      const stored = await getTransaction(tx.id, user.id);
      assert.equal(Number(stored.amount), 40, "the original row is untouched");
      assert.equal(stored.account_id, walletA.id);
    } finally {
      await dropUser(stranger.id);
    }
  });

  test("a stranger cannot edit somebody else's transaction at all", async () => {
    const stranger = await makeUser("edit-tx-stranger-2");
    try {
      const tx = await createTransaction({
        userId: user.id, accountId: walletA.id, categoryId: null,
        kind: "expense", amount: 10, note: "Coffee", occurredOn: "2026-08-06"
      });

      const result = await updateTransaction({
        id: tx.id, userId: stranger.id, accountId: null, categoryId: null,
        kind: "expense", amount: 999999, note: "hijacked", occurredOn: "2026-08-06"
      });

      assert.equal(result, null, "editing somebody else's row must come back empty");
      const stored = await getTransaction(tx.id, user.id);
      assert.equal(Number(stored.amount), 10, "the real owner's row is unchanged");
    } finally {
      await dropUser(stranger.id);
    }
  });

  after(closePool);
});
