import {
  listBudgetsWithSpend,
  uncategorizedSpend,
  upsertBudget
} from "../db/queries/budgets.js";
import { listCategories } from "../db/queries/categories.js";
import { listGoals } from "../db/queries/goals.js";
import {
  getAlerts,
  toBudgetPayload,
  toGoalPayload
} from "../services/analytics.js";
import { toBase } from "../services/fx.js";
import { monthLabel, monthStart, today } from "../utils/dates.js";

export async function listBudgetsPage(req, res, next) {
  try {
    const user = req.session.user;

    const [budgets, categories, goals, uncategorized] = await Promise.all([
      listBudgetsWithSpend(user.id, monthStart()),
      listCategories(user.id),
      listGoals(user.id),
      uncategorizedSpend(user.id, monthStart())
    ]);

    // Burn-rate alerts from the analytics service; null when it's offline.
    const alertsData = await getAlerts({
      today: today(),
      currency: user.currency,
      rate: res.locals.fxRate,
      budgets: toBudgetPayload(budgets),
      goals: toGoalPayload(goals)
    });

    res.render("budgets", {
      title: "Budgets",
      monthLabel: monthLabel(),
      budgets,
      expenseCategories: categories.filter((c) => c.kind === "expense"),
      uncategorized,
      alerts: alertsData ? alertsData.alerts : [],
      goalImpact: alertsData ? alertsData.goal_impact : null
    });
  } catch (error) {
    next(error);
  }
}

export async function setBudget(req, res, next) {
  const categoryId = Number.parseInt(req.body.categoryId, 10);
  const amount = Number.parseFloat(req.body.amount);

  if (!Number.isInteger(categoryId) || !Number.isFinite(amount) || amount < 0) {
    req.flash("error", "Pick a category and a budget amount.");
    return res.redirect("/budgets");
  }

  try {
    await upsertBudget({
      userId: req.session.user.id,
      categoryId,
      month: monthStart(),
      amount: toBase(req.session.user, amount)
    });

    req.flash("success", "Budget saved.");
    return res.redirect("/budgets");
  } catch (error) {
    return next(error);
  }
}
