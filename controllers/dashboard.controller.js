import { listBudgetsWithSpend } from "../db/queries/budgets.js";
import { listGoals } from "../db/queries/goals.js";
import {
  getMonthlySummary,
  listRecentTransactions
} from "../db/queries/transactions.js";
import {
  getAlerts,
  toBudgetPayload,
  toGoalPayload
} from "../services/analytics.js";
import { materializeDueRecurring } from "../services/recurring.js";
import { monthLabel, monthStart, today } from "../utils/dates.js";
import { catchUpCardNotices } from "./credit.controller.js";

export async function showDashboard(req, res, next) {
  try {
    const user = req.session.user;
    const month = monthStart();

    // Record any recurring transactions that have come due since last visit.
    await materializeDueRecurring(user.id);

    // A missed card minimum is worth an email, and the dashboard is where
    // somebody who has not opened the credit page will be found. Not awaited.
    catchUpCardNotices(user);

    const [summary, recent, budgets, goals] = await Promise.all([
      getMonthlySummary(user.id, month),
      listRecentTransactions(user.id, 5),
      listBudgetsWithSpend(user.id, month),
      listGoals(user.id)
    ]);

    // Burn-rate alerts from the analytics service; null when it's offline.
    const alertsData = await getAlerts({
      today: today(),
      currency: user.currency,
      rate: res.locals.fxRate,
      budgets: toBudgetPayload(budgets),
      goals: toGoalPayload(goals)
    });

    res.render("dashboard", {
      title: "Dashboard",
      monthLabel: monthLabel(),
      income: Number(summary.income),
      expenses: Number(summary.expenses),
      recent,
      budgets,
      goals,
      alerts: alertsData ? alertsData.alerts : [],
      goalImpact: alertsData ? alertsData.goal_impact : null
    });
  } catch (error) {
    next(error);
  }
}
