import {
  businessesDueForReview,
  claimMonthlyReview,
  getReview,
  listReviews,
  looseEntries,
  recategoriseTransaction,
  recordNotification,
  releaseMonthlyReview,
  saveReview,
  setAutoReview,
  setReviewEmail
} from "../db/queries/accountant.js";
import { listBills, listInvoices, outstandingTotals } from "../db/queries/accounting.js";
import { businessPnL, getBusiness, listBusinessTransactions, monthlyTrend } from "../db/queries/business.js";
import { inventorySummary, listProducts } from "../db/queries/inventory.js";
import { listSales } from "../db/queries/sales.js";
import { addProvision, listProvisions, payrollDeductionsTotal } from "../db/queries/tax.js";
import { aiEnabled, narrate, proposeCategories } from "../services/accountant.js";
import { mailEnabled, sendMail } from "../services/mailer.js";
import { reviewEmail } from "../utils/review-email.js";
import { config } from "../config/env.js";
import { reviewLedger, taxPosition } from "../utils/accounting.js";
import { incomeStatement } from "../utils/statements.js";
import { formatCurrency } from "../utils/currency.js";
import { convert } from "../services/fx.js";
import { DEFAULT_CURRENCY } from "../utils/currencies.js";
import { today } from "../utils/dates.js";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "../utils/categories.js";

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

// One implementation behind both the button and the monthly run, so an
// automatic close is exactly the review the owner would have got by clicking.
export async function performReview(business, user) {
  const { tax, review, fmt } = await gather(business, user);

  const loose = await looseEntries(business.id, user.id);
  const { proposals, mode: categoryMode } = await proposeCategories({
    entries: loose,
    allowed: PROPOSABLE,
    business
  });

  const { text: narrative, mode } = await narrate({ business, tax, review, fmt });

  const saved = await saveReview({
    businessId: business.id,
    userId: user.id,
    counts: review.counts,
    tax,
    narrative,
    mode,
    findings: review.findings
  });

  return { tax, review, proposals, categoryMode, narrative, saved, fmt };
}

// Post the close to whoever the business nominated. Failure is recorded as
// "nobody was told" and nothing more — a mail server having a bad afternoon
// must not cost the business its review.
export async function notifyReview({ business, user, tax, review, narrative, saved, fmt }) {
  const to = (business.review_email || "").trim();
  if (!to || !mailEnabled()) return { sent: false };

  const base = config.appUrl || `http://localhost:${config.port}`;
  const { subject, text, html } = reviewEmail({
    business, tax, review, narrative, fmt,
    url: `${base}/business/${business.id}/accountant`,
    when: new Date()
  });

  const result = await sendMail({ to, subject, text, html });
  if (result.sent) await recordNotification(saved.id, to);
  return result;
}

// Run this month's close if the business is opted in and it has not happened
// yet. The claim is taken first and handed back if the run fails, so a provider
// outage does not cost the business its monthly review.
export async function runMonthlyReviewIfDue(business, user) {
  if (!business.auto_review) return null;

  const previous = business.last_auto_review;
  if (!(await claimMonthlyReview(business.id))) return null;

  try {
    const outcome = await performReview(business, user);
    await notifyReview({ business, user, ...outcome });
    return outcome;
  } catch (error) {
    await releaseMonthlyReview(business.id, previous);
    console.warn(`Accountant: monthly review for business ${business.id} failed (${error.message})`);
    return null;
  }
}

// Called from pages elsewhere in the business area. Never awaited by the
// request: a close can take a while when a provider is configured, and no page
// should wait on it. Failures are logged, not surfaced.
export function catchUpMonthlyReviews(user) {
  businessesDueForReview(user.id)
    .then(async (businesses) => {
      for (const business of businesses) {
        await runMonthlyReviewIfDue(business, user);
      }
    })
    .catch((error) => {
      console.warn(`Accountant: monthly catch-up failed (${error.message})`);
    });
}

export async function showAccountant(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const userId = req.session.user.id;
    await runMonthlyReviewIfDue(business, req.session.user);

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
      mailReady: mailEnabled(),
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
    const { review, proposals, categoryMode } = await performReview(business, user);

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

export async function toggleAutoReview(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const on = req.body.autoReview === "on" || req.body.autoReview === "true";

  try {
    await setAutoReview(business.id, req.session.user.id, on);
    req.flash(
      "success",
      on
        ? "The accountant will close these books once a month from now on."
        : "Monthly reviews turned off — run one whenever you want instead."
    );
    return res.redirect(`/business/${business.id}/accountant`);
  } catch (error) {
    return next(error);
  }
}

export async function saveReviewEmail(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const address = (req.body.reviewEmail || "").trim();
  const back = `/business/${business.id}/accountant`;

  // Deliberately forgiving: the point is to catch a typo, not to police what a
  // mail server will accept.
  if (address && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    req.flash("error", "That does not look like an email address.");
    return res.redirect(back);
  }

  try {
    await setReviewEmail(business.id, req.session.user.id, address);
    req.flash(
      "success",
      address
        ? `The monthly close will be emailed to ${address}.`
        : "Monthly closes will not be emailed."
    );
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}
