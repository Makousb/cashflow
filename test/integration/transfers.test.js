import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { createAccount } from "../../db/queries/accounts.js";
import { createTransfer, deleteTransfer } from "../../db/queries/transfers.js";
import {
  createTransaction,
  deleteTransaction,
  getMonthlySummary,
  listRecentTransactions,
  updateTransaction
} from "../../db/queries/transactions.js";
import { closePool, dropUser, makeUser, one, q, skipWithoutDb } from "./helpers.js";

// Moving your own money between your own wallets is neither spending nor
// earning it — these tests are the proof that a transfer's two legs move
// real balances while staying invisible to every income/expense total, and
// that a transfer can only be undone as a whole, never half-corrected
// through the generic transaction edit/delete path.
describe("transfers between accounts", { skip: skipWithoutDb }, () => {
  let user;
  let stranger;
  let walletA;
  let walletB;
  let strangerWallet;

  before(async () => {
    user = await makeUser("transfer");
    stranger = await makeUser("transfer-stranger");
    walletA = await createAccount({ userId: user.id, name: "Cash", type: "cash" });
    walletB = await createAccount({ userId: user.id, name: "M-Pesa", type: "mobile_money" });
    strangerWallet = await createAccount({ userId: stranger.id, name: "Not Yours", type: "cash" });
  });

  after(async () => {
    await dropUser(user?.id);
    await dropUser(stranger?.id);
  });

  const balanceOf = async (id) =>
    Number((await one("SELECT balance FROM accounts WHERE id = $1", [id])).balance);

  test("moves the balance out of one wallet and into the other", async () => {
    const beforeA = await balanceOf(walletA.id);
    const beforeB = await balanceOf(walletB.id);

    const transfer = await createTransfer({
      userId: user.id, fromAccountId: walletA.id, toAccountId: walletB.id,
      amount: 5000, note: "Topping up M-Pesa", occurredOn: "2026-08-01"
    });

    assert.equal(await balanceOf(walletA.id), beforeA - 5000);
    assert.equal(await balanceOf(walletB.id), beforeB + 5000);

    const legs = await q(
      "SELECT * FROM transactions WHERE transfer_id = $1 ORDER BY account_id", [transfer.id]
    );
    assert.equal(legs.length, 2, "a transfer is exactly two transaction rows");
    assert.ok(legs.every((leg) => leg.kind === "transfer"));
  });

  test("is invisible to the monthly income/expense summary", async () => {
    const before = await getMonthlySummary(user.id, "2026-09-01");
    await createTransfer({
      userId: user.id, fromAccountId: walletA.id, toAccountId: walletB.id,
      amount: 1200, note: null, occurredOn: "2026-09-05"
    });
    const afterSummary = await getMonthlySummary(user.id, "2026-09-01");
    assert.equal(Number(afterSummary.income), Number(before.income));
    assert.equal(Number(afterSummary.expenses), Number(before.expenses));
  });

  test("shows once in history with both account names resolved", async () => {
    const transfer = await createTransfer({
      userId: user.id, fromAccountId: walletA.id, toAccountId: walletB.id,
      amount: 300, note: "Rounding test", occurredOn: "2026-08-02"
    });

    const recent = await listRecentTransactions(user.id, 50);
    const legs = recent.filter((tx) => tx.transfer_id === transfer.id);
    assert.equal(legs.length, 2);
    for (const leg of legs) {
      assert.equal(leg.transfer_from_name, "Cash");
      assert.equal(leg.transfer_to_name, "M-Pesa");
    }
  });

  test("refuses a wallet that belongs to somebody else", async () => {
    await assert.rejects(
      () => createTransfer({
        userId: user.id, fromAccountId: walletA.id, toAccountId: strangerWallet.id,
        amount: 100, note: null, occurredOn: "2026-08-03"
      }),
      /not one of yours/
    );
    await assert.rejects(
      () => createTransfer({
        userId: user.id, fromAccountId: strangerWallet.id, toAccountId: walletA.id,
        amount: 100, note: null, occurredOn: "2026-08-03"
      }),
      /not one of yours/
    );
  });

  test("refuses transferring a wallet to itself", async () => {
    await assert.rejects(
      () => createTransfer({
        userId: user.id, fromAccountId: walletA.id, toAccountId: walletA.id,
        amount: 100, note: null, occurredOn: "2026-08-03"
      }),
      /different wallets/
    );
  });

  test("deleting reverses both balances and removes both legs", async () => {
    const beforeA = await balanceOf(walletA.id);
    const beforeB = await balanceOf(walletB.id);

    const transfer = await createTransfer({
      userId: user.id, fromAccountId: walletA.id, toAccountId: walletB.id,
      amount: 750, note: null, occurredOn: "2026-08-04"
    });
    assert.equal(await balanceOf(walletA.id), beforeA - 750);
    assert.equal(await balanceOf(walletB.id), beforeB + 750);

    const removed = await deleteTransfer(transfer.id, user.id);
    assert.equal(removed, true);
    assert.equal(await balanceOf(walletA.id), beforeA, "wallet A is back to where it started");
    assert.equal(await balanceOf(walletB.id), beforeB, "wallet B is back to where it started");

    const legs = await q("SELECT id FROM transactions WHERE transfer_id = $1", [transfer.id]);
    assert.equal(legs.length, 0, "both legs are gone with the header row");
  });

  test("deleting somebody else's transfer does nothing", async () => {
    const transfer = await createTransfer({
      userId: user.id, fromAccountId: walletA.id, toAccountId: walletB.id,
      amount: 400, note: null, occurredOn: "2026-08-05"
    });

    const removed = await deleteTransfer(transfer.id, stranger.id);
    assert.equal(removed, false);

    const legs = await q("SELECT id FROM transactions WHERE transfer_id = $1", [transfer.id]);
    assert.equal(legs.length, 2, "a stranger's delete call must not touch it");

    await deleteTransfer(transfer.id, user.id);
  });

  test("editing one leg through the generic transaction form is refused, not half-applied", async () => {
    const beforeA = await balanceOf(walletA.id);
    const beforeB = await balanceOf(walletB.id);

    const transfer = await createTransfer({
      userId: user.id, fromAccountId: walletA.id, toAccountId: walletB.id,
      amount: 900, note: null, occurredOn: "2026-08-06"
    });
    const [leg] = await q(
      "SELECT id FROM transactions WHERE transfer_id = $1 AND account_id = $2",
      [transfer.id, walletA.id]
    );

    await assert.rejects(
      () => updateTransaction({
        id: leg.id, userId: user.id, accountId: walletA.id, categoryId: null,
        kind: "expense", amount: 900, note: "sneaky", occurredOn: "2026-08-06"
      }),
      (error) => error.code === "IS_A_TRANSFER"
    );

    assert.equal(await balanceOf(walletA.id), beforeA - 900, "unchanged by the refused edit");
    assert.equal(await balanceOf(walletB.id), beforeB + 900, "unchanged by the refused edit");

    await deleteTransfer(transfer.id, user.id);
  });

  test("deleting one leg through the generic transaction delete is refused, not half-reversed", async () => {
    const beforeA = await balanceOf(walletA.id);
    const beforeB = await balanceOf(walletB.id);

    const transfer = await createTransfer({
      userId: user.id, fromAccountId: walletA.id, toAccountId: walletB.id,
      amount: 600, note: null, occurredOn: "2026-08-07"
    });
    const [leg] = await q(
      "SELECT id FROM transactions WHERE transfer_id = $1 AND account_id = $2",
      [transfer.id, walletB.id]
    );

    await assert.rejects(
      () => deleteTransaction(leg.id, user.id),
      (error) => error.code === "IS_A_TRANSFER"
    );

    assert.equal(await balanceOf(walletA.id), beforeA - 600, "the refused delete left both sides alone");
    assert.equal(await balanceOf(walletB.id), beforeB + 600, "the refused delete left both sides alone");
    const legs = await q("SELECT id FROM transactions WHERE transfer_id = $1", [transfer.id]);
    assert.equal(legs.length, 2, "both legs are still there — nothing was orphaned");

    await deleteTransfer(transfer.id, user.id);
  });

  test("an ordinary transaction is completely unaffected by the transfer guard", async () => {
    const tx = await createTransaction({
      userId: user.id, accountId: walletA.id, categoryId: null,
      kind: "expense", amount: 50, note: "Coffee", occurredOn: "2026-08-08"
    });
    const updated = await updateTransaction({
      id: tx.id, userId: user.id, accountId: walletA.id, categoryId: null,
      kind: "expense", amount: 60, note: "Coffee and cake", occurredOn: "2026-08-08"
    });
    assert.equal(Number(updated.amount), 60);
    const removed = await deleteTransaction(tx.id, user.id);
    assert.equal(removed, true);
  });
});
