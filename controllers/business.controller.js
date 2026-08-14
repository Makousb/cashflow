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
import { catchUpMonthlyReviews } from "./accountant.controller.js";
import { toBase } from "../services/fx.js";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "../utils/categories.js";
import { today } from "../utils/dates.js";


// The business suite's modules. Bookkeeping is live; the rest are on the
// roadmap and shown as such so the section reflects the full plan.
export const MODULES = [
  { name: "Bookkeeping", icon: "document", status: "active", href: "",
    desc: "Record income and expenses and track profit & loss." },
  { name: "Advisor", icon: "chat", status: "active", href: "advisor",
    desc: "Ask about your finances and get instant, grounded answers." },
  { name: "General ledger", icon: "scale", status: "active", href: "ledger",
    desc: "Double-entry: the chart of accounts, every journal entry, and a trial balance." },
  { name: "Financial statements", icon: "document", status: "active", href: "statements",
    desc: "Income statement, balance sheet, and cash flow — from the ledger and from the categories." },
  { name: "Invoices (AR)", icon: "arrowDownBox", status: "active", href: "invoices",
    desc: "Track money customers owe you and mark it paid." },
  { name: "Bills (AP)", icon: "arrowUpBox", status: "active", href: "bills",
    desc: "Track vendor bills you owe and settle them." },
  { name: "Budgeting & planning", icon: "barChart", status: "active", href: "planning",
    desc: "Set targets and forecast cash flow." },
  { name: "Payroll", icon: "users", status: "active", href: "payroll",
    desc: "Pay employees and track deductions." },
  { name: "Tax preparation", icon: "receipt", status: "active", href: "tax",
    desc: "Estimate what is owed where you trade — income tax and VAT — and set it aside." },
  { name: "Stock locations", icon: "building", status: "active", href: "locations",
    desc: "Where each product actually is, and moving it between store, shelf and stall." },
  { name: "Group & jurisdictions", icon: "globe", status: "active", href: "group",
    desc: "Branches in other countries, each with its own books and tax, consolidated into one currency." },
  { name: "Sales & support", icon: "target", status: "active", href: "crm",
    desc: "A pipeline with a weighted forecast, and a support desk that knows when a case is late." },
  { name: "Marketing", icon: "megaphone", status: "active", href: "marketing",
    desc: "Funnels that collect emails, promotions, and the customer relationships behind them." },
  { name: "Accountant", icon: "calculator", status: "active", href: "accountant",
    desc: "An agent that reviews the books, computes the tax position, and proposes fixes." },
  { name: "Sales", icon: "card", status: "active", href: "sales",
    desc: "Sell from stock — units come off the shelf and the money is booked." },
  { name: "Inventory", icon: "box", status: "active", href: "inventory",
    desc: "Track stock levels, value, and cost of goods." },
  { name: "Ordering", icon: "truck", status: "active", href: "inventory",
    desc: "Low-stock alerts and purchase orders." },
  { name: "Supply chain", icon: "link", status: "active", href: "supply",
    desc: "Order from suppliers, fulfil orders, and chat live as they move." },
  { name: "Supply reports", icon: "trendingUp", status: "active", href: "supply/reports",
    desc: "Supplier scorecards, on-time delivery, and spend." }
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

    // Close the books for the month if that is switched on and has not happened
    // yet. Deliberately not awaited — the same way the personal dashboard lets
    // recurring transactions catch up without holding the page.
    catchUpMonthlyReviews(req.session.user);

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
