import { listAccounts } from "../db/queries/accounts.js";
import { listCategories } from "../db/queries/categories.js";
import {
  createTransaction,
  deleteTransaction,
  listRecentTransactions,
  updateTransaction
} from "../db/queries/transactions.js";
import { toBase } from "../services/fx.js";
import { materializeDueRecurring } from "../services/recurring.js";
import { today } from "../utils/dates.js";

export async function listTransactionsPage(req, res, next) {
  try {
    const userId = req.session.user.id;

    // Record any recurring transactions that have come due since last visit.
    await materializeDueRecurring(userId);

    const [transactions, accounts, categories] = await Promise.all([
      listRecentTransactions(userId),
      listAccounts(userId),
      listCategories(userId)
    ]);

    res.render("transactions", {
      title: "Transactions",
      transactions,
      accounts,
      categories,
      today: today()
    });
  } catch (error) {
    next(error);
  }
}

export async function addTransaction(req, res, next) {
  const amount = Number.parseFloat(req.body.amount);
  const kind = req.body.kind === "income" ? "income" : "expense";

  if (!Number.isFinite(amount) || amount <= 0) {
    req.flash("error", "Enter an amount greater than zero.");
    return res.redirect("/transactions");
  }

  try {
    await createTransaction({
      userId: req.session.user.id,
      accountId: req.body.accountId || null,
      categoryId: req.body.categoryId || null,
      kind,
      // Entered in the display currency; store in the account's base currency.
      amount: toBase(req.session.user, amount),
      note: (req.body.note || "").trim() || null,
      occurredOn: req.body.occurredOn || today()
    });

    req.flash("success", `${kind === "income" ? "Income" : "Expense"} recorded.`);
    return res.redirect("/transactions");
  } catch (error) {
    return next(error);
  }
}

export async function editTransaction(req, res, next) {
  const amount = Number.parseFloat(req.body.amount);
  const kind = req.body.kind === "income" ? "income" : "expense";

  if (!Number.isFinite(amount) || amount <= 0) {
    req.flash("error", "Enter an amount greater than zero.");
    return res.redirect("/transactions");
  }

  try {
    const updated = await updateTransaction({
      id: Number(req.params.id),
      userId: req.session.user.id,
      accountId: req.body.accountId || null,
      categoryId: req.body.categoryId || null,
      kind,
      amount: toBase(req.session.user, amount),
      note: (req.body.note || "").trim() || null,
      occurredOn: req.body.occurredOn || today()
    });

    req.flash(
      updated ? "success" : "error",
      updated ? "Transaction updated." : "Transaction not found."
    );
    return res.redirect("/transactions");
  } catch (error) {
    return next(error);
  }
}

export async function removeTransaction(req, res, next) {
  try {
    const removed = await deleteTransaction(
      Number(req.params.id),
      req.session.user.id
    );

    req.flash(
      removed ? "success" : "error",
      removed ? "Transaction deleted." : "Transaction not found."
    );
    return res.redirect("/transactions");
  } catch (error) {
    return next(error);
  }
}
