import {
  getReview,
  listReviews,
  looseEntries,
  recategoriseTransaction,
  saveReview
} from "../db/queries/accountant.js";
import { listBills, listInvoices, outstandingTotals } from "../db/queries/accounting.js";
import { businessPnL, getBusiness, listBusinessTransactions, monthlyTrend } from "../db/queries/business.js";
import { inventorySummary, listProducts } from "../db/queries/inventory.js";
import { listSales } from "../db/queries/sales.js";
import { addProvision, listProvisions, payrollDeductionsTotal } from "../db/queries/tax.js";
import { aiEnabled, narrate, proposeCategories } from "../services/accountant.js";
import { reviewLedger, taxPosition } from "../utils/accounting.js";
import { incomeStatement } from "../utils/statements.js";
import { formatCurrency } from "../utils/currency.js";
import { convert } from "../services/fx.js";
import { DEFAULT_CURRENCY } from "../utils/currencies.js";
import { today } from "../utils/dates.js";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "./business.controller.js";

// "Other" is a real option in the picker, but it is also exactly what the
// review asks the owner to resolve — so it is never proposed as an answer.
const PROPOSABLE = [
  ...INCOME_CATEGORIES,
  ...EXPENSE_CATEGORIES.filter((c) => c !== "Other")
];

async function requireBusiness(req, res) {
  const business = await getBusiness(Number(req.params.id), req.session.user.id);
  if (!business) {
    req.flash("error", "Business not found.");
    res.redirect("/business");
    return null;
  }
  return business;
}

// Amounts are stored in the owner's base currency; findings and the note quote
// them in whatever the owner is reading in.
function amountFormatter(user) {
  const display = user.currency || user.base_currency || DEFAULT_CURRENCY;
  const base = user.base_currency || display;
  return (amount) => formatCurrency(convert(amount, base, display), display);
}

// Everything the review reads, in one go.
async function gather(business, user) {
  const userId = user.id;
  const fmt = amountFormatter(user);
  const [pnl, stock, outstanding, deductions, provisions, transactions,
         invoices, bills, products, sales, trend] = await Promise.all([
    businessPnL(business.id, userId),
    inventorySummary(business.id, userId),
    outstandingTotals(business.id, userId),
    payrollDeductionsTotal(business.id, userId),
    listProvisions(business.id, userId),
    listBusinessTransactions(business.id, userId, 1000),
    listInvoices(business.id, userId),
    listBills(business.id, userId),
    listProducts(business.id, userId),
    listSales(business.id, userId, 500),
    monthlyTrend(business.id, userId, 6)
  ]);

  const statements = incomeStatement(pnl.revenue, pnl.byCategory, {
    closingInventory: Number(stock.stock_value)
  });

  const tax = taxPosition({
    accrualProfit: statements.netProfit,
    rate: Number(business.income_tax_rate),
    payrollDeductions: Number(deductions),
    setAside: provisions.reduce((sum, p) => sum + Number(p.amount), 0)
  });

  const review = reviewLedger({
    transactions, invoices, bills, products, sales, trend,
    tax, stock: statements.stock, today: today(), fmt
  });

  return { pnl, statements, tax, review, outstanding, transactions, fmt };
}

export async function showAccountant(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const userId = req.session.user.id;
    const [history, loose] = await Promise.all([
      listReviews(business.id, userId),
      looseEntries(business.id, userId)
    ]);

    const latest = history[0] ? await getReview(history[0].id, userId) : null;

    // The headline figures are recomputed on every view, so they are never
    // stale. The note and the findings are the review as it was written, which
    // is the point of keeping it — so say when the books have moved since.
    const position = latest ? (await gather(business, req.session.user)).tax : null;
    const stale = Boolean(
      latest &&
      (Math.abs(position.shortfall - Number(latest.tax_shortfall)) > 0.01 ||
        Math.abs(position.totalOwed - Number(latest.tax_owed)) > 0.01)
    );

    return res.render("accountant", {
      title: `${business.name} · Accountant`,
      business,
      latest,
      position,
      stale,
      history,
      looseCount: loose.length,
      live: aiEnabled(),
      proposals: req.session.proposals?.[business.id] || {}
    });
  } catch (error) {
    return next(error);
  }
}

export async function runReview(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const user = req.session.user;
  const back = `/business/${business.id}/accountant`;

  try {
    const { tax, review, fmt } = await gather(business, user);

    const loose = await looseEntries(business.id, user.id);
    const { proposals, mode: categoryMode } = await proposeCategories({
      entries: loose,
      allowed: PROPOSABLE,
      business
    });

    const { text: narrative, mode } = await narrate({ business, tax, review, fmt });

    await saveReview({
      businessId: business.id,
      userId: user.id,
      counts: review.counts,
      tax,
      narrative,
      mode,
      findings: review.findings
    });

    // Proposals are held for the session rather than written to the books —
    // nothing changes until the owner applies it.
    req.session.proposals = req.session.proposals || {};
    req.session.proposals[business.id] = Object.fromEntries(proposals);

    const suggested = proposals.size;
    req.flash(
      "success",
      review.clean
        ? "Review complete — the books are clean."
        : `Review complete — ${review.counts.total} finding(s)` +
          (suggested > 0
            ? `, and ${suggested} categor${suggested === 1 ? "y" : "ies"} proposed` +
              `${categoryMode === "ai" ? "" : " from the built-in rules"}.`
            : ".")
    );
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

// Set aside what the review says is missing. This posts a provision — it does
// not move money — so the worst case is a number the owner can delete.
export async function applyProvision(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/accountant`;

  try {
    const { tax } = await gather(business, req.session.user);
    if (tax.shortfall <= 0) {
      req.flash("error", "Nothing to set aside — the tax owed is already covered.");
      return res.redirect(back);
    }

    await addProvision({
      businessId: business.id,
      userId: req.session.user.id,
      amount: Number(tax.shortfall.toFixed(2)),
      note: "Set aside on the accountant's review",
      setOn: today()
    });

    req.flash("success", "Tax provision set aside — the position is now fully covered.");
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

// Apply one proposed category. The category is re-checked here even though the
// proposal was already filtered: it arrives back through a form.
export async function applyCategory(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/accountant`;
  const category = (req.body.category || "").trim();
  const transactionId = Number(req.params.txId);

  if (!PROPOSABLE.includes(category)) {
    req.flash("error", "That is not a category this business uses.");
    return res.redirect(back);
  }

  try {
    const updated = await recategoriseTransaction({
      id: transactionId,
      businessId: business.id,
      userId: req.session.user.id,
      category
    });

    if (!updated) {
      req.flash("error", "Entry not found.");
      return res.redirect(back);
    }

    if (req.session.proposals?.[business.id]) {
      delete req.session.proposals[business.id][transactionId];
    }

    req.flash("success", `Entry #${transactionId} filed under ${category}.`);
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

export async function showLooseEntries(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const loose = await looseEntries(business.id, req.session.user.id);
    return res.render("accountant-entries", {
      title: `${business.name} · Entries to file`,
      business,
      entries: loose,
      categories: PROPOSABLE,
      proposals: req.session.proposals?.[business.id] || {}
    });
  } catch (error) {
    return next(error);
  }
}
