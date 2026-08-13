import {
  createBill,
  createInvoice,
  deleteBill,
  deleteInvoice,
  getBill,
  getInvoice,
  listBills,
  listInvoices,
  markBillPaid,
  markInvoicePaid,
  outstandingTotals
} from "../db/queries/accounting.js";
import {
  addBusinessTransaction,
  businessPnL,
  getBusiness
} from "../db/queries/business.js";
import { inventorySummary } from "../db/queries/inventory.js";
import { toBase } from "../services/fx.js";
import { ledgerLines, listAccounts, unpostedCount } from "../db/queries/ledger.js";
import {
  billPaidEntry,
  invoicePaidEntry,
  ledgerBalanceSheet,
  fiscalYear,
  ledgerIncomeStatement,
  reconcile,
  trialBalance
} from "../utils/ledger.js";
import { today } from "../utils/dates.js";
import { balanceSheet, cashFlow, incomeStatement } from "../utils/statements.js";
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "../utils/categories.js";

async function requireBusiness(req, res) {
  const business = await getBusiness(Number(req.params.id), req.session.user.id);
  if (!business) {
    req.flash("error", "Business not found.");
    res.redirect("/business");
    return null;
  }
  return business;
}

function outstandingSum(items) {
  return items
    .filter((i) => i.status === "unpaid")
    .reduce((s, i) => s + Number(i.amount), 0);
}

// --- Accounts receivable ---

export async function showInvoices(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const invoices = await listInvoices(business.id, req.session.user.id);
    return res.render("invoices", {
      title: `${business.name} · Invoices`,
      business,
      invoices,
      outstanding: outstandingSum(invoices),
      incomeCategories: INCOME_CATEGORIES,
      today: today()
    });
  } catch (error) {
    return next(error);
  }
}

export async function addInvoice(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const customer = (req.body.customer || "").trim();
  const amount = Number.parseFloat(req.body.amount);
  if (!customer || !Number.isFinite(amount) || amount <= 0) {
    req.flash("error", "Enter a customer and an amount.");
    return res.redirect(`/business/${business.id}/invoices`);
  }

  try {
    await createInvoice({
      businessId: business.id,
      userId: req.session.user.id,
      customer,
      amount: toBase(req.session.user, amount),
      category: INCOME_CATEGORIES.includes(req.body.category) ? req.body.category : "Sales",
      issuedOn: req.body.issuedOn || today(),
      dueOn: req.body.dueOn || null,
      note: (req.body.note || "").trim() || null
    });
    req.flash("success", "Invoice created.");
    return res.redirect(`/business/${business.id}/invoices`);
  } catch (error) {
    return next(error);
  }
}

export async function payInvoice(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    const invoice = await getInvoice(Number(req.params.invId), req.session.user.id);
    if (!invoice || invoice.status === "paid") {
      req.flash("error", "Invoice not found or already paid.");
      return res.redirect(`/business/${business.id}/invoices`);
    }

    // Payment received. The cash book records money in, as it always has; the
    // journal settles the receivable rather than booking revenue, because the
    // revenue was earned when the invoice was raised. Booking it here as well
    // is the classic way to report one year's takings as two.
    const transaction = await addBusinessTransaction({
      businessId: business.id,
      userId: req.session.user.id,
      kind: "income",
      amount: Number(invoice.amount),
      category: invoice.category,
      note: `Invoice paid: ${invoice.customer}`,
      occurredOn: today(),
      entry: invoicePaidEntry({
        amount: Number(invoice.amount),
        memo: `Invoice settled: ${invoice.customer}`
      })
    });
    await markInvoicePaid(invoice.id, req.session.user.id, today(), transaction.id);

    req.flash("success", "Invoice marked paid and recorded as income.");
    return res.redirect(`/business/${business.id}/invoices`);
  } catch (error) {
    return next(error);
  }
}

export async function removeInvoice(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    await deleteInvoice(Number(req.params.invId), req.session.user.id);
    req.flash("success", "Invoice deleted.");
    return res.redirect(`/business/${business.id}/invoices`);
  } catch (error) {
    return next(error);
  }
}

// --- Accounts payable ---

export async function showBills(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const bills = await listBills(business.id, req.session.user.id);
    return res.render("bills", {
      title: `${business.name} · Bills`,
      business,
      bills,
      outstanding: outstandingSum(bills),
      expenseCategories: EXPENSE_CATEGORIES,
      today: today()
    });
  } catch (error) {
    return next(error);
  }
}

export async function addBill(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const vendor = (req.body.vendor || "").trim();
  const amount = Number.parseFloat(req.body.amount);
  if (!vendor || !Number.isFinite(amount) || amount <= 0) {
    req.flash("error", "Enter a vendor and an amount.");
    return res.redirect(`/business/${business.id}/bills`);
  }

  try {
    await createBill({
      businessId: business.id,
      userId: req.session.user.id,
      vendor,
      amount: toBase(req.session.user, amount),
      category: EXPENSE_CATEGORIES.includes(req.body.category) ? req.body.category : "Other",
      issuedOn: req.body.issuedOn || today(),
      dueOn: req.body.dueOn || null,
      note: (req.body.note || "").trim() || null
    });
    req.flash("success", "Bill added.");
    return res.redirect(`/business/${business.id}/bills`);
  } catch (error) {
    return next(error);
  }
}

export async function payBill(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    const bill = await getBill(Number(req.params.billId), req.session.user.id);
    if (!bill || bill.status === "paid") {
      req.flash("error", "Bill not found or already paid.");
      return res.redirect(`/business/${business.id}/bills`);
    }

    // As with an invoice: the cost landed when the bill arrived, so paying it
    // clears the payable and spends cash without incurring anything new.
    const transaction = await addBusinessTransaction({
      businessId: business.id,
      userId: req.session.user.id,
      kind: "expense",
      amount: Number(bill.amount),
      category: bill.category,
      note: `Bill paid: ${bill.vendor}`,
      occurredOn: today(),
      entry: billPaidEntry({
        amount: Number(bill.amount),
        memo: `Bill settled: ${bill.vendor}`
      })
    });
    await markBillPaid(bill.id, req.session.user.id, today(), transaction.id);

    req.flash("success", "Bill marked paid and recorded as an expense.");
    return res.redirect(`/business/${business.id}/bills`);
  } catch (error) {
    return next(error);
  }
}

export async function removeBill(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    await deleteBill(Number(req.params.billId), req.session.user.id);
    req.flash("success", "Bill deleted.");
    return res.redirect(`/business/${business.id}/bills`);
  } catch (error) {
    return next(error);
  }
}

// --- Financial statements ---

export async function showStatements(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const userId = req.session.user.id;
    const [pnl, outstanding, inventory, accounts, lines, unposted] = await Promise.all([
      businessPnL(business.id, userId),
      outstandingTotals(business.id, userId),
      inventorySummary(business.id, userId),
      listAccounts(business.id, userId),
      // Cumulative and closing entries included — a balance sheet is a standing
      // position, and a close is part of how equity got where it is.
      ledgerLines(business.id, userId),
      unpostedCount(business.id, userId)
    ]);

    // ★ The income statement is a PERIOD, and once a year has been closed its
    // income and expense accounts are empty. Reading it cumulatively would show
    // a business that had closed a year as having earned nothing ever since. So
    // it is scoped to the open financial year, with closing entries left out.
    const period = fiscalYear(business.fiscal_year_end_month, today());
    const periodLines = await ledgerLines(business.id, userId, {
      from: period.start, to: period.end, withClosing: false
    });

    const cash = pnl.net; // income received − expenses paid
    const stockValue = Number(inventory.stock_value);

    // The same books read two ways. The derived statements group categorised
    // cash movements and estimate cost of sales from closing stock; the ledger
    // posts both halves of everything as it happens. Showing them side by side
    // is the honest thing to do while both exist — where they disagree, the
    // reason is usually worth knowing rather than worth hiding.
    const trial = trialBalance(accounts, lines);
    const fromLedger = ledgerIncomeStatement(trialBalance(accounts, periodLines));
    const derived = incomeStatement(pnl.revenue, pnl.byCategory, {
      closingInventory: stockValue
    });

    return res.render("statements", {
      title: `${business.name} · Financial statements`,
      business,
      trial,
      fromLedger,
      ledgerBalance: ledgerBalanceSheet(trial),
      reconciliation: reconcile(fromLedger, derived),
      period,
      unposted,
      // Stock on hand is held back out of cost of sales: it is an asset on the
      // balance sheet below, not a cost of trading yet.
      income: incomeStatement(pnl.revenue, pnl.byCategory, {
        closingInventory: stockValue
      }),
      balance: balanceSheet({
        cash,
        receivable: outstanding.receivable,
        inventory: stockValue,
        payable: outstanding.payable
      }),
      cash: cashFlow(pnl.revenue, pnl.byCategory),
      cashOnHand: cash
    });
  } catch (error) {
    return next(error);
  }
}
