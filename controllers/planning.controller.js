import { businessPnL, getBusiness } from "../db/queries/business.js";
import {
  deleteBudget,
  listBudgets,
  monthlyActuals,
  upsertBudget
} from "../db/queries/businessBudgets.js";
import { toBase } from "../services/fx.js";
import { monthStart } from "../utils/dates.js";
import { EXPENSE_CATEGORIES } from "../utils/categories.js";

async function requireBusiness(req, res) {
  const business = await getBusiness(Number(req.params.id), req.session.user.id);
  if (!business) {
    req.flash("error", "Business not found.");
    res.redirect("/business");
    return null;
  }
  return business;
}

// Labels for the next `count` months, starting next month.
function futureMonths(count) {
  const labels = [];
  const now = new Date();
  for (let i = 1; i <= count; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    labels.push(d.toLocaleDateString("en-US", { month: "short", year: "numeric" }));
  }
  return labels;
}

export async function showPlanning(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const userId = req.session.user.id;
    const [budgets, actuals, pnl] = await Promise.all([
      listBudgets(business.id, userId),
      monthlyActuals(business.id, userId, monthStart()),
      businessPnL(business.id, userId)
    ]);

    const revenueBudget = budgets.find((b) => b.kind === "income");
    const expenseBudgets = budgets
      .filter((b) => b.kind === "expense")
      .map((b) => {
        const actual = actuals.expenses[b.category] || 0;
        const amount = Number(b.amount);
        return {
          ...b,
          actual,
          ratio: amount > 0 ? Math.min((actual / amount) * 100, 100) : 0,
          over: actual > amount
        };
      });

    const budgetedRevenue = revenueBudget ? Number(revenueBudget.amount) : 0;
    const budgetedExpenses = expenseBudgets.reduce((s, b) => s + Number(b.amount), 0);
    const projectedNet = budgetedRevenue - budgetedExpenses;

    // Six-month cash-flow projection from the current net position.
    let running = pnl.net;
    const forecast = futureMonths(6).map((label) => {
      running += projectedNet;
      return { label, projectedNet, cumulative: running };
    });

    return res.render("planning", {
      title: `${business.name} · Planning`,
      business,
      revenueBudget,
      revenueActual: actuals.revenue,
      revenueRatio: budgetedRevenue > 0
        ? Math.min((actuals.revenue / budgetedRevenue) * 100, 100)
        : 0,
      expenseBudgets,
      budgetedRevenue,
      budgetedExpenses,
      projectedNet,
      currentNet: pnl.net,
      forecast,
      expenseCategories: EXPENSE_CATEGORIES
    });
  } catch (error) {
    return next(error);
  }
}

export async function setBudget(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const target = (req.body.target || "").trim();
  const amount = Number.parseFloat(req.body.amount);

  if (!Number.isFinite(amount) || amount < 0) {
    req.flash("error", "Enter a budget amount.");
    return res.redirect(`/business/${business.id}/planning`);
  }

  const isRevenue = target === "Revenue";
  if (!isRevenue && !EXPENSE_CATEGORIES.includes(target)) {
    req.flash("error", "Pick what to budget for.");
    return res.redirect(`/business/${business.id}/planning`);
  }

  try {
    await upsertBudget({
      businessId: business.id,
      userId: req.session.user.id,
      kind: isRevenue ? "income" : "expense",
      category: isRevenue ? "Revenue" : target,
      amount: toBase(req.session.user, amount)
    });
    req.flash("success", "Budget saved.");
    return res.redirect(`/business/${business.id}/planning`);
  } catch (error) {
    return next(error);
  }
}

export async function removeBudget(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    await deleteBudget(Number(req.params.budgetId), req.session.user.id);
    req.flash("success", "Budget removed.");
    return res.redirect(`/business/${business.id}/planning`);
  } catch (error) {
    return next(error);
  }
}
