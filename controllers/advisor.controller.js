import { outstandingTotals } from "../db/queries/accounting.js";
import {
  businessPnL,
  getBusiness,
  monthlyTrend
} from "../db/queries/business.js";
import { inventorySummary } from "../db/queries/inventory.js";
import { listEmployees } from "../db/queries/payroll.js";
import { payrollDeductionsTotal } from "../db/queries/tax.js";
import { aiEnabled, ask } from "../services/advisor.js";
import { computePayslip } from "../utils/payroll.js";
import { balanceSheet, cashFlow, incomeStatement } from "../utils/statements.js";

async function requireBusiness(req, res) {
  const business = await getBusiness(Number(req.params.id), req.session.user.id);
  if (!business) {
    req.flash("error", "Business not found.");
    res.redirect("/business");
    return null;
  }
  return business;
}

export async function showAdvisor(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    return res.render("advisor", {
      title: `${business.name} · Advisor`,
      business,
      live: aiEnabled(),
      prompts: [
        "How's my business doing?",
        "How are sales trending?",
        "Where should I cut costs?",
        "What's my balance sheet?",
        "How much cash do I have?",
        "What tax should I set aside?"
      ]
    });
  } catch (error) {
    return next(error);
  }
}

// Assemble the full financial picture the advisor reasons over: headline
// figures, the three statements, and a month-by-month trend.
async function buildSnapshot(business, userId) {
  const [pnl, outstanding, inventory, employees, payrollDeductions, trend] =
    await Promise.all([
      businessPnL(business.id, userId),
      outstandingTotals(business.id, userId),
      inventorySummary(business.id, userId),
      listEmployees(business.id, userId),
      payrollDeductionsTotal(business.id, userId),
      monthlyTrend(business.id, userId, 6)
    ]);

  const active = employees.filter((e) => e.active);
  const monthlyPayroll = active.reduce((s, e) => s + computePayslip(e).gross, 0);
  const taxRate = Number(business.income_tax_rate);
  const estimatedTax = Math.max(pnl.net, 0) * (taxRate / 100) + payrollDeductions;

  return {
    name: business.name,
    industry: business.industry,
    revenue: pnl.revenue,
    expenses: pnl.expenses,
    netProfit: pnl.net,
    margin: pnl.margin,
    cash: pnl.net,
    receivable: outstanding.receivable,
    payable: outstanding.payable,
    inventoryValue: Number(inventory.stock_value),
    lowStockCount: inventory.low_count,
    employeeCount: active.length,
    monthlyPayroll,
    taxRate,
    estimatedTax,
    topExpenses: pnl.byCategory
      .slice(0, 5)
      .map((c) => ({ category: c.category, total: Number(c.total) })),
    // Full financial statements (to date) + monthly trend.
    statements: {
      income: incomeStatement(pnl.revenue, pnl.byCategory),
      balance: balanceSheet({
        cash: pnl.net,
        receivable: outstanding.receivable,
        inventory: Number(inventory.stock_value),
        payable: outstanding.payable
      }),
      cashFlow: cashFlow(pnl.revenue, pnl.byCategory)
    },
    trend,
    thisMonth: trend[trend.length - 1] || null,
    lastMonth: trend.length >= 2 ? trend[trend.length - 2] : null
  };
}

export async function askAdvisor(req, res, next) {
  try {
    const business = await getBusiness(Number(req.params.id), req.session.user.id);
    if (!business) {
      return res.status(404).json({ error: "Business not found." });
    }

    const question = (req.body.question || "").trim();
    if (!question) {
      return res.status(400).json({ error: "Ask a question." });
    }

    const snapshot = await buildSnapshot(business, req.session.user.id);
    const answer = await ask(question, snapshot, (n) => res.locals.money(n));

    return res.json({ answer: answer.text, mode: answer.mode });
  } catch (error) {
    return next(error);
  }
}
