// Double-entry bookkeeping: the general ledger this app's books now rest on.
//
// Everything before this recorded money as a single row with a category on it —
// true enough, and the statements were derived by grouping those categories. It
// could not answer the questions a ledger answers: what is owed to us right now
// as a balance rather than a sum of unpaid invoices, what the stock on the
// shelves is worth as an account, whether the books balance at all.
//
// So every movement is now two halves that must agree. The rule is the whole
// mechanism: an entry that does not balance is not written, anywhere, ever. That
// is what makes a trial balance meaningful, and it is why the check lives here
// as a pure function rather than in whichever query happened to be writing.
//
// Pure. Rows in, plain objects out, no database anywhere near it.

import { toISODate, toLocalDate } from "./dates.js";

const round = (n) => Math.round(Number(n) * 100) / 100;

// Which way each kind of account increases. Debits increase what the business
// HAS and what it SPENDS; credits increase what it OWES, what it is WORTH, and
// what it EARNS. Everything below follows from this table.
export const ACCOUNT_TYPES = {
  asset: { normal: "debit", statement: "balance", label: "Assets" },
  liability: { normal: "credit", statement: "balance", label: "Liabilities" },
  equity: { normal: "credit", statement: "balance", label: "Equity" },
  income: { normal: "credit", statement: "income", label: "Income" },
  expense: { normal: "debit", statement: "income", label: "Expenses" }
};

export const normalBalance = (type) => ACCOUNT_TYPES[type]?.normal ?? null;

// The chart every business starts with. Codes follow the convention every
// bookkeeper already knows (1000s assets, 2000s liabilities, and so on) so the
// numbers mean the same thing here as they do in the books they came from.
//
// `key` is how the code refers to an account without knowing its id or caring
// whether the owner has since renamed it. Renaming "Sales revenue" must not stop
// a sale from posting.
export const STANDARD_CHART = [
  { key: "cash", code: "1000", name: "Cash", type: "asset" },
  { key: "accounts_receivable", code: "1100", name: "Accounts receivable", type: "asset" },
  { key: "inventory", code: "1200", name: "Inventory", type: "asset" },

  { key: "accounts_payable", code: "2000", name: "Accounts payable", type: "liability" },
  { key: "payroll_liabilities", code: "2100", name: "Payroll deductions payable", type: "liability" },
  { key: "tax_payable", code: "2200", name: "Tax payable", type: "liability" },

  { key: "owners_equity", code: "3000", name: "Owner's equity", type: "equity" },
  { key: "retained_earnings", code: "3900", name: "Retained earnings", type: "equity" },

  { key: "sales_revenue", code: "4000", name: "Sales revenue", type: "income" },
  { key: "service_revenue", code: "4100", name: "Service revenue", type: "income" },
  { key: "other_income", code: "4900", name: "Other income", type: "income" },

  { key: "cogs", code: "5000", name: "Cost of goods sold", type: "expense" },
  { key: "payroll_expense", code: "5100", name: "Payroll", type: "expense" },
  { key: "rent_expense", code: "5200", name: "Rent", type: "expense" },
  { key: "utilities_expense", code: "5300", name: "Utilities", type: "expense" },
  { key: "supplies_expense", code: "5400", name: "Supplies", type: "expense" },
  { key: "marketing_expense", code: "5500", name: "Marketing", type: "expense" },
  { key: "transport_expense", code: "5600", name: "Transport", type: "expense" },
  { key: "fees_expense", code: "5700", name: "Fees", type: "expense" },
  { key: "tax_expense", code: "5800", name: "Taxes", type: "expense" },
  { key: "other_expense", code: "5900", name: "Other", type: "expense" }
];

// The app's own category names, mapped onto the chart. This is the bridge
// between the books as they were kept and the books as they are kept now, so it
// has to cover every category the rest of the app can produce.
//
// ★ "Inventory Purchase" lands on an ASSET, not an expense. Buying stock does
// not spend anything — it swaps cash for goods, and the cost arrives when the
// goods leave. The old category-derived statement reached the same answer by
// subtracting closing stock at the end; the ledger gets there by never calling
// it a cost in the first place, which is the same truth told in order.
export const CATEGORY_ACCOUNTS = {
  income: {
    Sales: "sales_revenue",
    Services: "service_revenue",
    Interest: "other_income",
    "Other Income": "other_income"
  },
  expense: {
    "Inventory Purchase": "inventory",
    // The name inventory purchases carried before the rename. Books written
    // under it must keep posting to the same place.
    "Cost of Goods": "inventory",
    Rent: "rent_expense",
    Utilities: "utilities_expense",
    Payroll: "payroll_expense",
    Supplies: "supplies_expense",
    Marketing: "marketing_expense",
    Transport: "transport_expense",
    Fees: "fees_expense",
    Taxes: "tax_expense",
    Other: "other_expense"
  }
};

// Where a category posts, falling back to the catch-all rather than refusing.
// A category nobody anticipated must not be able to stop money being recorded;
// it lands in "Other" and shows up there to be reclassified.
export function accountForCategory(kind, category) {
  const table = CATEGORY_ACCOUNTS[kind] || {};
  return table[category] || (kind === "income" ? "other_income" : "other_expense");
}

// --- The rule ---

// One side or the other, never both, never neither. A line carrying both a
// debit and a credit is not a line, it is two, and letting one through would
// make every total downstream a guess.
export function checkLine(line) {
  const debit = round(line.debit || 0);
  const credit = round(line.credit || 0);

  if (debit < 0 || credit < 0) return "A line cannot carry a negative amount.";
  if (debit === 0 && credit === 0) return "A line must carry an amount.";
  if (debit > 0 && credit > 0) return "A line is a debit or a credit, not both.";
  // By key or by id: the built-in accounts are addressed by name so a rename
  // cannot break a posting, and the owner's own accounts have no key, so
  // closing reaches those by id.
  if (!line.account && !line.accountId) return "A line must name an account.";
  return null;
}

// Whether an entry may be written. Returns the totals either way, because the
// difference is the useful part of a refusal — "out by 0.01" is a typo and
// "out by 4,000" is a missing line.
export function checkEntry(lines = []) {
  if (lines.length < 2) {
    return { ok: false, reason: "An entry needs at least two lines.", debits: 0, credits: 0, difference: 0 };
  }

  for (const line of lines) {
    const problem = checkLine(line);
    if (problem) {
      return { ok: false, reason: problem, debits: 0, credits: 0, difference: 0 };
    }
  }

  const debits = round(lines.reduce((sum, l) => sum + Number(l.debit || 0), 0));
  const credits = round(lines.reduce((sum, l) => sum + Number(l.credit || 0), 0));
  const difference = round(debits - credits);

  if (difference !== 0) {
    return {
      ok: false,
      reason: `Debits and credits must agree. Debits ${debits.toFixed(2)}, ` +
        `credits ${credits.toFixed(2)}, out by ${Math.abs(difference).toFixed(2)}.`,
      debits,
      credits,
      difference
    };
  }

  return { ok: true, reason: null, debits, credits, difference: 0 };
}

// Shorthand for the commonest entry there is: one thing debited, one credited.
export const simpleEntry = (debitAccount, creditAccount, amount, memo = null) => [
  { account: debitAccount, debit: round(amount), credit: 0, memo },
  { account: creditAccount, debit: 0, credit: round(amount), memo }
];

// --- What each thing that happens looks like as an entry ---
//
// Every builder here is pure and returns lines only. Resolving a key to an
// account id and writing the rows is the database layer's job; deciding what
// the movement MEANS is this file's, so it can be read and argued with in one
// place instead of being spread across six controllers.

// Money in or out of the till, with the far side chosen by the category. Cash
// on one side is not an assumption — a business_transaction is recorded when
// money actually moves, which is what makes this the cash side of the books.
export function cashMovementEntry({ kind, category, amount, memo }) {
  const account = accountForCategory(kind, category);
  return kind === "income"
    ? simpleEntry("cash", account, amount, memo)
    : simpleEntry(account, "cash", amount, memo);
}

// An invoice raised: the customer owes us, and we have earned it. This is the
// accrual half the old books never recorded — revenue used to appear only when
// the money arrived, which is why receivables had to be counted by summing
// unpaid invoices instead of read off an account.
export const invoiceRaisedEntry = ({ amount, category, memo }) =>
  simpleEntry("accounts_receivable", accountForCategory("income", category), amount, memo);

// And settled: the debt turns into cash. No revenue here — it was earned when
// the invoice was raised, and booking it twice is the classic way to report a
// year's takings as two years'.
export const invoicePaidEntry = ({ amount, memo }) =>
  simpleEntry("cash", "accounts_receivable", amount, memo);

// A bill received: we owe it, and it is a cost (or stock) the moment it arrives.
export const billRaisedEntry = ({ amount, category, memo }) =>
  simpleEntry(accountForCategory("expense", category), "accounts_payable", amount, memo);

export const billPaidEntry = ({ amount, memo }) =>
  simpleEntry("accounts_payable", "cash", amount, memo);

// A sale over the counter. Cash sales take money now; credit sales raise a
// receivable — which is the same entry an invoice makes, because that is what a
// credit sale is.
export function saleEntry({ total, cost = 0, payment = "cash", memo }) {
  const lines = payment === "credit"
    ? simpleEntry("accounts_receivable", "sales_revenue", total, memo)
    : simpleEntry("cash", "sales_revenue", total, memo);

  // The cost of what was sold leaves the shelves in the same breath. Only when
  // the cost is actually known — a service, or a line sold off-catalog, has
  // none, and inventing one would be worse than leaving it out.
  if (round(cost) > 0) {
    lines.push(...simpleEntry("cogs", "inventory", cost, memo));
  }
  return lines;
}

// Payroll, told properly: the whole gross is the cost to the business, the net
// is what leaves as cash, and the difference is money withheld that is owed to
// somebody else and has not been paid yet. Booking only the gross against cash
// would say the deductions had already been remitted.
export function payrollEntry({ gross, deductions = 0, memo }) {
  const withheld = round(deductions);
  const net = round(round(gross) - withheld);
  const lines = [{ account: "payroll_expense", debit: round(gross), credit: 0, memo }];

  if (net > 0) lines.push({ account: "cash", debit: 0, credit: net, memo });
  if (withheld > 0) lines.push({ account: "payroll_liabilities", debit: 0, credit: withheld, memo });
  return lines;
}

// Stock arriving against a purchase order: cash becomes goods, no cost yet.
export const stockReceivedEntry = ({ amount, memo }) =>
  simpleEntry("inventory", "cash", amount, memo);

// Providing for tax. The business recognises that it owes something and puts a
// figure on it: the charge lands in the period that earned the profit, and the
// obligation sits as a liability until it is actually remitted.
//
// No cash moves. Setting money aside is not the same act as owing it, and this
// entry is about the owing — which is why it does not touch the cash account
// even though the page calls it "set aside".
export const provisionEntry = ({ amount, memo }) =>
  simpleEntry("tax_expense", "tax_payable", amount, memo);

// And the same entry backwards, for a provision the owner takes back. A ledger
// is not corrected by deleting from it — every other posting here can be traced
// to what caused it, and a line that can vanish is worth less than one that
// cannot. So the reversal is itself an entry, and both remain readable.
export const provisionReversedEntry = ({ amount, memo }) =>
  simpleEntry("tax_payable", "tax_expense", amount, memo);

// --- Reading the ledger back ---

// Every account's side totals and its resulting balance, signed the way that
// account naturally runs so a healthy figure is a positive one.
export function trialBalance(accounts = [], lines = []) {
  const byAccount = new Map();
  for (const account of accounts) {
    byAccount.set(account.id, {
      ...account,
      debits: 0,
      credits: 0,
      balance: 0
    });
  }

  for (const line of lines) {
    const row = byAccount.get(line.account_id);
    if (!row) continue;
    row.debits = round(row.debits + Number(line.debit || 0));
    row.credits = round(row.credits + Number(line.credit || 0));
  }

  const rows = [];
  let debits = 0;
  let credits = 0;

  for (const row of byAccount.values()) {
    row.balance = normalBalance(row.type) === "debit"
      ? round(row.debits - row.credits)
      : round(row.credits - row.debits);
    debits = round(debits + row.debits);
    credits = round(credits + row.credits);
    rows.push(row);
  }

  rows.sort((a, b) => String(a.code).localeCompare(String(b.code)));

  return {
    rows,
    // Only accounts that have actually been used — a chart of twenty rows of
    // zeroes tells nobody anything.
    active: rows.filter((r) => r.debits !== 0 || r.credits !== 0),
    debits,
    credits,
    difference: round(debits - credits),
    // The whole point. If this is ever false, something wrote an entry it
    // should not have been able to write.
    balanced: round(debits - credits) === 0
  };
}

const sumBalances = (rows, type) =>
  round(rows.filter((r) => r.type === type).reduce((sum, r) => sum + r.balance, 0));

// The income statement, straight off the ledger. No periodic estimate and no
// category grouping: cost of sales is what was posted to it when goods left,
// and stock still on the shelves was never called a cost to begin with.
// ★ Tax sits BELOW the operating line, the way a real income statement reads:
// gross profit, operating expenses, profit before tax, tax, profit after tax.
// That is not only convention. Tax is charged ON the profit, so folding it in
// with rent and wages would make "operating expenses" a figure that grows when
// the business does well, and would leave the ledger reporting an after-tax net
// profit against a derived statement that has no tax in it at all — a gap that
// looks like a data problem and is not one.
export function ledgerIncomeStatement(trial) {
  const rows = trial.rows;
  const revenue = sumBalances(rows, "income");
  const cogs = round(
    rows.filter((r) => r.key === "cogs").reduce((sum, r) => sum + r.balance, 0)
  );
  const taxExpense = round(
    rows.filter((r) => r.key === "tax_expense").reduce((sum, r) => sum + r.balance, 0)
  );
  const operating = rows
    .filter((r) => r.type === "expense" && r.key !== "cogs" && r.key !== "tax_expense"
      && r.balance !== 0)
    .map((r) => ({ code: r.code, category: r.name, total: r.balance }))
    .sort((a, b) => b.total - a.total);

  const operatingTotal = round(operating.reduce((sum, r) => sum + r.total, 0));
  const grossProfit = round(revenue - cogs);
  const profitBeforeTax = round(grossProfit - operatingTotal);

  return {
    revenue,
    cogs,
    grossProfit,
    operating,
    operatingTotal,
    profitBeforeTax,
    taxExpense,
    netProfit: round(profitBeforeTax - taxExpense),
    margin: revenue > 0 ? round((profitBeforeTax / revenue) * 100) : 0
  };
}

// The balance sheet, likewise. Equity carries the period's profit explicitly —
// income and expenses close into it — so this balances by arithmetic rather
// than by defining equity as whatever makes it balance, which is what the old
// one had to do.
export function ledgerBalanceSheet(trial) {
  const rows = trial.rows;
  const assets = rows.filter((r) => r.type === "asset" && r.balance !== 0)
    .map((r) => ({ code: r.code, name: r.name, total: r.balance }));
  const liabilities = rows.filter((r) => r.type === "liability" && r.balance !== 0)
    .map((r) => ({ code: r.code, name: r.name, total: r.balance }));

  const assetTotal = sumBalances(rows, "asset");
  const liabilityTotal = sumBalances(rows, "liability");
  const postedEquity = sumBalances(rows, "equity");
  const earned = ledgerIncomeStatement(trial).netProfit;
  const equityTotal = round(postedEquity + earned);

  return {
    assets: { rows: assets, total: assetTotal },
    liabilities: { rows: liabilities, total: liabilityTotal },
    equity: { posted: postedEquity, earned, total: equityTotal },
    balanced: Math.abs(round(assetTotal - (liabilityTotal + equityTotal))) < 0.01,
    difference: round(assetTotal - (liabilityTotal + equityTotal))
  };
}

// --- Closing the year ---

// The financial year a date falls in, for a business whose year ends in the
// given month. December is the ordinary case; plenty of places and plenty of
// businesses use another, and the difference is not cosmetic — it decides which
// year a December sale is taxed in.
export function fiscalYear(endMonth, forDate) {
  const month = Math.min(Math.max(Number(endMonth) || 12, 1), 12);
  const date = toLocalDate(forDate);
  const [year, monthIndex] = [date.getFullYear(), date.getMonth() + 1];

  // Past the end month, the date belongs to the year ending NEXT time that
  // month comes round.
  const endYear = monthIndex > month ? year + 1 : year;
  const end = new Date(endYear, month, 0);
  const start = new Date(endYear - 1, month, 1);

  return {
    start: toISODate(start),
    end: toISODate(end),
    // "2026" when the year ends in December, "2025/26" when it straddles two.
    label: month === 12 ? String(endYear) : `${endYear - 1}/${String(endYear).slice(2)}`
  };
}

// The entry that closes a period.
//
// Income and expense accounts measure a stretch of time, not a standing
// quantity — they are the only accounts that mean nothing without a date range
// attached. Closing empties them into equity, where the result stops being "how
// we did" and becomes "what the business is worth". After it, a new year starts
// from zero, which is the whole point of a year.
//
// Every income and expense balance is written back to nothing and the
// difference lands in retained earnings, so the entry balances by construction:
// whatever the two sides came to, their difference is exactly what is left over.
export function closingEntry(trial, memo = "Year-end closing") {
  const lines = [];
  let income = 0;
  let expense = 0;

  for (const row of trial.rows) {
    if (row.type !== "income" && row.type !== "expense") continue;
    if (row.balance === 0) continue;

    // Written back by its own normal side: a credit balance is cleared with a
    // debit, and a balance that has somehow run the other way is cleared the
    // other way. Handled generally so a refund-heavy month cannot produce an
    // entry that does not balance.
    const clearingDebit = row.type === "income" ? row.balance > 0 : row.balance < 0;
    const amount = Math.abs(row.balance);

    lines.push({
      // Closing has to reach accounts the owner added themselves, which have no
      // key — so this addresses them by id, and postEntry accepts either.
      account: row.key || null,
      accountId: row.id,
      debit: clearingDebit ? amount : 0,
      credit: clearingDebit ? 0 : amount,
      memo
    });

    if (row.type === "income") income = round(income + row.balance);
    else expense = round(expense + row.balance);
  }

  const net = round(income - expense);
  if (lines.length === 0) return { lines: [], income, expense, net, empty: true };

  // The result goes to equity: a profit increases what the business is worth,
  // a loss reduces it.
  lines.push({
    account: "retained_earnings",
    debit: net < 0 ? Math.abs(net) : 0,
    credit: net > 0 ? net : 0,
    memo
  });

  return { lines, income, expense, net, empty: false };
}

// What the two ways of keeping these books say, side by side.
//
// The old statement groups categorised cash movements and estimates cost of
// sales from closing stock; the ledger posts both halves of everything as it
// happens. They should agree, and where they do not the reason is usually worth
// knowing — revenue recorded straight into the books with no sale behind it
// carries no cost of sales, so the ledger reports the fatter margin, honestly.
export function reconcile(ledger, derived) {
  const line = (label, a, b) => ({
    label,
    ledger: round(a),
    derived: round(b),
    difference: round(a - b),
    agrees: Math.abs(round(a - b)) < 0.01
  });

  const lines = [
    line("Revenue", ledger.revenue, derived.revenue),
    line("Cost of sales", ledger.cogs, derived.cogs),
    line("Operating expenses", ledger.operatingTotal, derived.operatingTotal),
    // Compared BEFORE tax, deliberately. The derived statement has no tax in it
    // — provisions are not ledger transactions over there — so comparing an
    // after-tax figure against a pre-tax one would report a difference on every
    // set of books that had ever provided for tax.
    line("Profit before tax", ledger.profitBeforeTax, derived.netProfit)
  ];

  return {
    lines,
    agrees: lines.every((l) => l.agrees),
    // Carried alongside rather than compared, so the page can say what the
    // ledger knows and the other column simply does not.
    taxExpense: round(ledger.taxExpense),
    netAfterTax: round(ledger.netProfit)
  };
}
