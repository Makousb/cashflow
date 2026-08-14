import { listAccounts } from "../db/queries/accounts.js";
import { getDefaultCategoryId } from "../db/queries/categories.js";
import { addToGoal, createGoal, getGoal, listGoals } from "../db/queries/goals.js";
import { createTransaction } from "../db/queries/transactions.js";
import { toBase } from "../services/fx.js";
import { today } from "../utils/dates.js";

export async function listGoalsPage(req, res, next) {
  try {
    const [goals, accounts] = await Promise.all([
      listGoals(req.session.user.id),
      listAccounts(req.session.user.id)
    ]);
    res.render("goals", { title: "Savings Goals", goals, accounts });
  } catch (error) {
    next(error);
  }
}

export async function addGoal(req, res, next) {
  const name = (req.body.name || "").trim();
  const targetAmount = Number.parseFloat(req.body.targetAmount);

  if (!name || !Number.isFinite(targetAmount) || targetAmount <= 0) {
    req.flash("error", "Give your goal a name and a target amount.");
    return res.redirect("/goals");
  }

  try {
    await createGoal({
      userId: req.session.user.id,
      name,
      targetAmount: toBase(req.session.user, targetAmount),
      targetDate: req.body.targetDate || null
    });

    req.flash("success", "Goal planted. Start growing it!");
    return res.redirect("/goals");
  } catch (error) {
    return next(error);
  }
}

export async function contributeToGoal(req, res, next) {
  const amount = Number.parseFloat(req.body.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    req.flash("error", "Enter a contribution greater than zero.");
    return res.redirect("/goals");
  }

  try {
    const userId = req.session.user.id;
    const goal = await getGoal(Number(req.params.id), userId);

    if (!goal) {
      req.flash("error", "Goal not found.");
      return res.redirect("/goals");
    }

    const baseAmount = toBase(req.session.user, amount);

    // Money set aside for a goal has to leave a wallet, or the same shilling
    // counts as both spendable and saved — the balance shown for the wallet it
    // supposedly left never moves. Recorded as an expense against the chosen
    // account, the same way a loan payment is: it shows up in the ordinary
    // transaction history rather than a separate ledger only this page knows
    // about, and the wallet select follows the loan payment form's own
    // pattern — an explicit "No account" choice for a rough figure logged
    // with nothing behind it, rather than that being the unlabelled default.
    if (req.body.accountId) {
      const categoryId = await getDefaultCategoryId("Savings");
      await createTransaction({
        userId,
        accountId: req.body.accountId,
        categoryId,
        kind: "expense",
        amount: baseAmount,
        note: `Savings: ${goal.name}`,
        occurredOn: today()
      });
    }

    await addToGoal(goal.id, userId, baseAmount);

    req.flash("success", "Contribution added.");
    return res.redirect("/goals");
  } catch (error) {
    return next(error);
  }
}
