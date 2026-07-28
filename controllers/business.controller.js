import {
  addBusinessTransaction,
  businessPnL,
  createBusiness,
  deleteBusiness,
  deleteBusinessTransaction,
  getBusiness,
  listBusinesses,
  listBusinessTransactions
} from "../db/queries/business.js";
import { toBase } from "../services/fx.js";
import { today } from "../utils/dates.js";

export const INCOME_CATEGORIES = ["Sales", "Services", "Interest", "Other Income"];
export const EXPENSE_CATEGORIES = [
  "Cost of Goods",
  "Rent",
  "Utilities",
  "Payroll",
  "Supplies",
  "Marketing",
  "Transport",
  "Fees",
  "Taxes",
  "Other"
];

// The business suite's modules. Bookkeeping is live; the rest are on the
// roadmap and shown as such so the section reflects the full plan.
export const MODULES = [
  { name: "Bookkeeping", icon: "📒", status: "active", href: "",
    desc: "Record income and expenses and track profit & loss." },
  { name: "Budgeting & planning", icon: "📊", status: "active", href: "planning",
    desc: "Set targets and forecast cash flow." },
  { name: "Payroll", icon: "👥", status: "active", href: "payroll",
    desc: "Pay employees and track deductions." },
  { name: "Tax preparation", icon: "🧾", status: "active", href: "tax",
    desc: "Estimate tax owed and set it aside." },
  { name: "Inventory", icon: "📦", status: "active", href: "inventory",
    desc: "Track stock levels, value, and cost of goods." },
  { name: "Ordering", icon: "🚚", status: "active", href: "inventory",
    desc: "Low-stock alerts and purchase orders." }
];

export async function showBusinessHub(req, res, next) {
  try {
    const businesses = await listBusinesses(req.session.user.id);
    res.render("business", { title: "Business", businesses });
  } catch (error) {
    next(error);
  }
}

export async function addBusiness(req, res, next) {
  const name = (req.body.name || "").trim();
  const industry = (req.body.industry || "").trim() || null;

  if (!name) {
    req.flash("error", "Give your business a name.");
    return res.redirect("/business");
  }

  try {
    const business = await createBusiness({
      userId: req.session.user.id,
      name,
      industry
    });
    req.flash("success", `${business.name} is ready — start keeping its books.`);
    return res.redirect(`/business/${business.id}`);
  } catch (error) {
    return next(error);
  }
}

export async function showBusinessDashboard(req, res, next) {
  try {
    const userId = req.session.user.id;
    const business = await getBusiness(Number(req.params.id), userId);
    if (!business) {
      req.flash("error", "Business not found.");
      return res.redirect("/business");
    }

    const [pnl, entries] = await Promise.all([
      businessPnL(business.id, userId),
      listBusinessTransactions(business.id, userId, 50)
    ]);

    res.render("business-dashboard", {
      title: business.name,
      business,
      pnl,
      entries,
      modules: MODULES,
      incomeCategories: INCOME_CATEGORIES,
      expenseCategories: EXPENSE_CATEGORIES,
      today: today()
    });
  } catch (error) {
    next(error);
  }
}

export async function addEntry(req, res, next) {
  const businessId = Number(req.params.id);
  const amount = Number.parseFloat(req.body.amount);
  const kind = req.body.kind === "income" ? "income" : "expense";
  const allowed = kind === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
  const category = allowed.includes(req.body.category) ? req.body.category : "Other";

  if (!Number.isFinite(amount) || amount <= 0) {
    req.flash("error", "Enter an amount greater than zero.");
    return res.redirect(`/business/${businessId}`);
  }

  try {
    const business = await getBusiness(businessId, req.session.user.id);
    if (!business) {
      req.flash("error", "Business not found.");
      return res.redirect("/business");
    }

    await addBusinessTransaction({
      businessId,
      userId: req.session.user.id,
      kind,
      amount: toBase(req.session.user, amount),
      category,
      note: (req.body.note || "").trim() || null,
      occurredOn: req.body.occurredOn || today()
    });

    req.flash("success", `${kind === "income" ? "Income" : "Expense"} recorded.`);
    return res.redirect(`/business/${businessId}`);
  } catch (error) {
    return next(error);
  }
}

export async function removeEntry(req, res, next) {
  try {
    await deleteBusinessTransaction(
      Number(req.params.entryId),
      req.session.user.id
    );
    req.flash("success", "Entry deleted.");
    return res.redirect(`/business/${req.params.id}`);
  } catch (error) {
    return next(error);
  }
}

export async function removeBusiness(req, res, next) {
  try {
    const removed = await deleteBusiness(
      Number(req.params.id),
      req.session.user.id
    );
    req.flash(
      removed ? "success" : "error",
      removed ? "Business and its books deleted." : "Business not found."
    );
    return res.redirect("/business");
  } catch (error) {
    return next(error);
  }
}
