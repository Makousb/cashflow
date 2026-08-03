import { businessPnL, getBusiness } from "../db/queries/business.js";
import {
  addProvision,
  deleteProvision,
  listProvisions,
  payrollDeductionsTotal,
  updateTaxRate
} from "../db/queries/tax.js";
import { inventorySummary } from "../db/queries/inventory.js";
import { toBase } from "../services/fx.js";
import { taxPosition } from "../utils/accounting.js";
import { incomeStatement } from "../utils/statements.js";
import { today } from "../utils/dates.js";

async function requireBusiness(req, res) {
  const business = await getBusiness(Number(req.params.id), req.session.user.id);
  if (!business) {
    req.flash("error", "Business not found.");
    res.redirect("/business");
    return null;
  }
  return business;
}

export async function showTax(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const userId = req.session.user.id;
    const [pnl, stock, payrollDeductions, provisions] = await Promise.all([
      businessPnL(business.id, userId),
      inventorySummary(business.id, userId),
      payrollDeductionsTotal(business.id, userId),
      listProvisions(business.id, userId)
    ]);

    // Taxable profit is the accrual figure from the income statement, not the
    // cash net. Taxing the cash net would tax the business on money it spent
    // filling its own shelves, and would disagree with both the statements page
    // and the accountant's review.
    const statements = incomeStatement(pnl.revenue, pnl.byCategory, {
      closingInventory: Number(stock.stock_value)
    });
    const position = taxPosition({
      accrualProfit: statements.netProfit,
      rate: Number(business.income_tax_rate),
      payrollDeductions,
      setAside: provisions.reduce((sum, p) => sum + Number(p.amount), 0)
    });

    const { rate, taxableProfit, incomeTax, totalOwed, setAside, coverage } = position;
    const remaining = totalOwed - setAside;

    return res.render("tax", {
      title: `${business.name} · Tax`,
      business,
      rate,
      pnl,
      taxableProfit,
      incomeTax,
      payrollDeductions,
      totalOwed,
      setAside,
      remaining,
      coverage,
      provisions,
      today: today()
    });
  } catch (error) {
    return next(error);
  }
}

export async function updateSettings(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  let rate = Number.parseFloat(req.body.rate);
  rate = Number.isFinite(rate) ? Math.min(Math.max(rate, 0), 100) : 30;

  try {
    await updateTaxRate(business.id, req.session.user.id, rate);
    req.flash("success", `Income tax rate set to ${rate}%.`);
    return res.redirect(`/business/${business.id}/tax`);
  } catch (error) {
    return next(error);
  }
}

export async function setAside(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const amount = Number.parseFloat(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    req.flash("error", "Enter an amount to set aside.");
    return res.redirect(`/business/${business.id}/tax`);
  }

  try {
    await addProvision({
      businessId: business.id,
      userId: req.session.user.id,
      amount: toBase(req.session.user, amount),
      note: (req.body.note || "").trim() || null,
      setOn: req.body.setOn || today()
    });
    req.flash("success", "Set aside for tax.");
    return res.redirect(`/business/${business.id}/tax`);
  } catch (error) {
    return next(error);
  }
}

export async function removeProvision(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    await deleteProvision(Number(req.params.provId), req.session.user.id);
    req.flash("success", "Provision removed.");
    return res.redirect(`/business/${business.id}/tax`);
  } catch (error) {
    return next(error);
  }
}
