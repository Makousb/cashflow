import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  accountForCategory,
  billPaidEntry,
  billRaisedEntry,
  cashMovementEntry,
  checkEntry,
  checkLine,
  invoicePaidEntry,
  invoiceRaisedEntry,
  ledgerBalanceSheet,
  ledgerIncomeStatement,
  provisionEntry,
  provisionReversedEntry,
  normalBalance,
  payrollEntry,
  reconcile,
  saleEntry,
  trialBalance
} from "../../utils/ledger.js";

const debitOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((s, l) => s + (l.debit || 0), 0);
const creditOn = (lines, account) =>
  lines.filter((l) => l.account === account).reduce((s, l) => s + (l.credit || 0), 0);
const balances = (lines) => checkEntry(lines).ok;

describe("which way an account runs", () => {
  test("assets and expenses are debit accounts", () => {
    assert.equal(normalBalance("asset"), "debit");
    assert.equal(normalBalance("expense"), "debit");
  });

  test("liabilities, equity and income are credit accounts", () => {
    assert.equal(normalBalance("liability"), "credit");
    assert.equal(normalBalance("equity"), "credit");
    assert.equal(normalBalance("income"), "credit");
  });
});

describe("a line", () => {
  test("must carry one side or the other", () => {
    assert.match(checkLine({ account: "cash", debit: 5, credit: 5 }), /not both/);
    assert.match(checkLine({ account: "cash", debit: 0, credit: 0 }), /must carry an amount/);
  });

  test("may not be negative", () => {
    assert.match(checkLine({ account: "cash", debit: -5, credit: 0 }), /negative/);
  });

  test("must name an account", () => {
    assert.match(checkLine({ debit: 5, credit: 0 }), /must name an account/);
  });

  test("is fine with one side filled in", () => {
    assert.equal(checkLine({ account: "cash", debit: 5, credit: 0 }), null);
  });
});

describe("an entry", () => {
  test("is refused when the sides do not agree, and says by how much", () => {
    const out = checkEntry([
      { account: "cash", debit: 100, credit: 0 },
      { account: "sales_revenue", debit: 0, credit: 90 }
    ]);
    assert.equal(out.ok, false);
    assert.equal(out.difference, 10);
    assert.match(out.reason, /out by 10\.00/);
  });

  test("needs at least two lines — one side alone is not an entry", () => {
    const out = checkEntry([{ account: "cash", debit: 100, credit: 0 }]);
    assert.equal(out.ok, false);
    assert.match(out.reason, /at least two lines/);
  });

  test("passes when both sides come to the same total", () => {
    const out = checkEntry([
      { account: "cash", debit: 100, credit: 0 },
      { account: "sales_revenue", debit: 0, credit: 60 },
      { account: "service_revenue", debit: 0, credit: 40 }
    ]);
    assert.equal(out.ok, true);
    assert.equal(out.debits, 100);
    assert.equal(out.credits, 100);
  });

  test("rounding to the cent is not a difference", () => {
    const out = checkEntry([
      { account: "cash", debit: 0.1 + 0.2, credit: 0 },
      { account: "sales_revenue", debit: 0, credit: 0.3 }
    ]);
    assert.equal(out.ok, true);
  });
});

describe("where a category posts", () => {
  test("stock lands on the inventory ASSET, not an expense", () => {
    assert.equal(accountForCategory("expense", "Inventory Purchase"), "inventory");
  });

  test("including under the name it carried before the rename", () => {
    assert.equal(accountForCategory("expense", "Cost of Goods"), "inventory");
  });

  test("a category nobody anticipated lands in the catch-all rather than failing", () => {
    assert.equal(accountForCategory("expense", "Sponsorship"), "other_expense");
    assert.equal(accountForCategory("income", "Royalties"), "other_income");
  });
});

describe("money in and out of the till", () => {
  test("income takes cash in and credits what earned it", () => {
    const lines = cashMovementEntry({ kind: "income", category: "Sales", amount: 500 });
    assert.equal(debitOn(lines, "cash"), 500);
    assert.equal(creditOn(lines, "sales_revenue"), 500);
    assert.ok(balances(lines));
  });

  test("an expense pays cash out", () => {
    const lines = cashMovementEntry({ kind: "expense", category: "Rent", amount: 200 });
    assert.equal(debitOn(lines, "rent_expense"), 200);
    assert.equal(creditOn(lines, "cash"), 200);
  });

  test("buying stock swaps cash for an asset and costs nothing yet", () => {
    const lines = cashMovementEntry({ kind: "expense", category: "Inventory Purchase", amount: 800 });
    assert.equal(debitOn(lines, "inventory"), 800);
    assert.equal(creditOn(lines, "cash"), 800);
  });
});

describe("invoices and bills", () => {
  test("raising an invoice earns the revenue and creates the debt", () => {
    const lines = invoiceRaisedEntry({ amount: 1000, category: "Sales" });
    assert.equal(debitOn(lines, "accounts_receivable"), 1000);
    assert.equal(creditOn(lines, "sales_revenue"), 1000);
  });

  test("settling it books NO revenue — only the debt turning into cash", () => {
    const lines = invoicePaidEntry({ amount: 1000 });
    assert.equal(debitOn(lines, "cash"), 1000);
    assert.equal(creditOn(lines, "accounts_receivable"), 1000);
    assert.equal(creditOn(lines, "sales_revenue"), 0, "revenue was earned when it was raised");
  });

  test("a bill incurs the cost when it arrives and clears the debt when paid", () => {
    const raised = billRaisedEntry({ amount: 300, category: "Utilities" });
    assert.equal(debitOn(raised, "utilities_expense"), 300);
    assert.equal(creditOn(raised, "accounts_payable"), 300);

    const paid = billPaidEntry({ amount: 300 });
    assert.equal(debitOn(paid, "accounts_payable"), 300);
    assert.equal(creditOn(paid, "cash"), 300);
    assert.equal(debitOn(paid, "utilities_expense"), 0, "the cost was incurred when it arrived");
  });
});

describe("a sale", () => {
  test("for cash takes money and relieves the stock it sold", () => {
    const lines = saleEntry({ total: 500, cost: 300, payment: "cash" });
    assert.equal(debitOn(lines, "cash"), 500);
    assert.equal(creditOn(lines, "sales_revenue"), 500);
    assert.equal(debitOn(lines, "cogs"), 300);
    assert.equal(creditOn(lines, "inventory"), 300);
    assert.ok(balances(lines));
  });

  test("on credit raises a receivable instead of taking cash", () => {
    const lines = saleEntry({ total: 500, cost: 300, payment: "credit" });
    assert.equal(debitOn(lines, "accounts_receivable"), 500);
    assert.equal(debitOn(lines, "cash"), 0);
    assert.ok(balances(lines));
  });

  test("with no known cost posts no cost of sales rather than inventing one", () => {
    const lines = saleEntry({ total: 500, cost: 0, payment: "cash" });
    assert.equal(debitOn(lines, "cogs"), 0);
    assert.equal(lines.length, 2);
    assert.ok(balances(lines));
  });
});

describe("payroll", () => {
  test("costs the gross, pays out the net, and owes the difference", () => {
    const lines = payrollEntry({ gross: 1000, deductions: 250 });
    assert.equal(debitOn(lines, "payroll_expense"), 1000);
    assert.equal(creditOn(lines, "cash"), 750);
    assert.equal(creditOn(lines, "payroll_liabilities"), 250);
    assert.ok(balances(lines), "the three sides still agree");
  });

  test("with nothing withheld it is just gross against cash", () => {
    const lines = payrollEntry({ gross: 1000, deductions: 0 });
    assert.equal(creditOn(lines, "cash"), 1000);
    assert.equal(creditOn(lines, "payroll_liabilities"), 0);
    assert.ok(balances(lines));
  });
});

// A small set of books, posted the way the app would post them, so the readers
// below are tested against something that actually happened rather than numbers
// chosen to make them pass.
const ACCOUNTS = [
  { id: 1, key: "cash", code: "1000", name: "Cash", type: "asset" },
  { id: 2, key: "accounts_receivable", code: "1100", name: "Accounts receivable", type: "asset" },
  { id: 3, key: "inventory", code: "1200", name: "Inventory", type: "asset" },
  { id: 4, key: "accounts_payable", code: "2000", name: "Accounts payable", type: "liability" },
  { id: 5, key: "sales_revenue", code: "4000", name: "Sales revenue", type: "income" },
  { id: 6, key: "cogs", code: "5000", name: "Cost of goods sold", type: "expense" },
  { id: 7, key: "rent_expense", code: "5200", name: "Rent", type: "expense" }
];

// Bought 800 of stock on credit; sold goods costing 300 for 500 cash; paid 200 rent.
// The same chart plus the two tax accounts, for the provision cases below.
const WITH_TAX_ACCOUNTS = [
  ...ACCOUNTS,
  { id: 8, key: "tax_expense", code: "5800", name: "Taxes", type: "expense" },
  { id: 9, key: "tax_payable", code: "2200", name: "Tax payable", type: "liability" }
];

const LINES = [
  { account_id: 3, debit: 800, credit: 0 },
  { account_id: 4, debit: 0, credit: 800 },
  { account_id: 1, debit: 500, credit: 0 },
  { account_id: 5, debit: 0, credit: 500 },
  { account_id: 6, debit: 300, credit: 0 },
  { account_id: 3, debit: 0, credit: 300 },
  { account_id: 7, debit: 200, credit: 0 },
  { account_id: 1, debit: 0, credit: 200 }
];

describe("the trial balance", () => {
  const trial = trialBalance(ACCOUNTS, LINES);

  test("has both sides equal, which is the whole point", () => {
    assert.equal(trial.debits, 1800);
    assert.equal(trial.credits, 1800);
    assert.equal(trial.balanced, true);
  });

  test("signs each balance the way its account runs", () => {
    const cash = trial.rows.find((r) => r.key === "cash");
    assert.equal(cash.balance, 300, "500 in less 200 out");

    const payable = trial.rows.find((r) => r.key === "accounts_payable");
    assert.equal(payable.balance, 800, "a credit balance shows positive on a liability");
  });

  test("stock left on the shelves is what was bought less what sold", () => {
    assert.equal(trial.rows.find((r) => r.key === "inventory").balance, 500);
  });

  test("leaves untouched accounts out of the active list", () => {
    assert.ok(!trial.active.some((r) => r.key === "accounts_receivable"));
  });
});

describe("the statements read off the ledger", () => {
  const trial = trialBalance(ACCOUNTS, LINES);

  test("gross profit is revenue less what the goods actually cost", () => {
    const income = ledgerIncomeStatement(trial);
    assert.equal(income.revenue, 500);
    assert.equal(income.cogs, 300);
    assert.equal(income.grossProfit, 200);
  });

  test("cost of sales is kept out of operating expenses", () => {
    const income = ledgerIncomeStatement(trial);
    assert.equal(income.operatingTotal, 200, "rent only");
    assert.equal(income.netProfit, 0);
  });

  test("the balance sheet balances, with profit carried into equity", () => {
    const sheet = ledgerBalanceSheet(trial);
    assert.equal(sheet.assets.total, 800, "300 cash + 500 stock");
    assert.equal(sheet.liabilities.total, 800);
    assert.equal(sheet.equity.earned, 0);
    assert.equal(sheet.balanced, true);
  });

  test("and keeps balancing once there is a profit to carry", () => {
    const withProfit = trialBalance(ACCOUNTS, [
      ...LINES,
      { account_id: 1, debit: 400, credit: 0 },
      { account_id: 5, debit: 0, credit: 400 }
    ]);
    const sheet = ledgerBalanceSheet(withProfit);
    assert.equal(sheet.equity.earned, 400);
    assert.equal(sheet.balanced, true);
  });
});

describe("providing for tax", () => {
  test("charges the period and creates the obligation, moving no cash", () => {
    const lines = provisionEntry({ amount: 24450 });
    assert.equal(debitOn(lines, "tax_expense"), 24450);
    assert.equal(creditOn(lines, "tax_payable"), 24450);
    assert.equal(creditOn(lines, "cash"), 0, "setting aside is not paying");
    assert.ok(balances(lines));
  });

  test("and withdrawing it is the same entry backwards", () => {
    const lines = provisionReversedEntry({ amount: 24450 });
    assert.equal(debitOn(lines, "tax_payable"), 24450);
    assert.equal(creditOn(lines, "tax_expense"), 24450);
    assert.ok(balances(lines));
  });

  test("so a provision made and withdrawn nets to nothing", () => {
    const trial = trialBalance(WITH_TAX_ACCOUNTS, [
      ...LINES,
      { account_id: 8, debit: 100, credit: 0 },
      { account_id: 9, debit: 0, credit: 100 },
      { account_id: 9, debit: 100, credit: 0 },
      { account_id: 8, debit: 0, credit: 100 }
    ]);
    assert.equal(trial.rows.find((r) => r.key === "tax_expense").balance, 0);
    assert.equal(trial.rows.find((r) => r.key === "tax_payable").balance, 0);
    assert.equal(trial.balanced, true);
  });
});

describe("where tax sits in the income statement", () => {
  // 100 of tax provided for, on top of the base books.
  const trial = trialBalance(WITH_TAX_ACCOUNTS, [
    ...LINES,
    { account_id: 8, debit: 100, credit: 0 },
    { account_id: 9, debit: 0, credit: 100 }
  ]);
  const income = ledgerIncomeStatement(trial);

  test("BELOW the operating line, not among the running costs", () => {
    assert.equal(income.operatingTotal, 200, "rent only — tax is not an operating expense");
    assert.equal(income.taxExpense, 100);
  });

  test("so profit before tax is unchanged by providing for it", () => {
    assert.equal(income.profitBeforeTax, 0, "same as before the provision");
    assert.equal(income.netProfit, -100, "after tax");
  });

  test("and the obligation shows as a liability", () => {
    const sheet = ledgerBalanceSheet(trial);
    assert.ok(sheet.liabilities.rows.some((r) => r.name === "Tax payable"));
    assert.equal(sheet.balanced, true, "still balances with tax accrued");
  });
});

describe("comparing the two ways of reading the books", () => {
  const ledger = { revenue: 500, cogs: 300, operatingTotal: 200,
    profitBeforeTax: 0, taxExpense: 0, netProfit: 0 };

  test("says so when they agree", () => {
    const out = reconcile(ledger, { revenue: 500, cogs: 300, operatingTotal: 200, netProfit: 0 });
    assert.equal(out.agrees, true);
  });

  test("and names the line that differs when they do not", () => {
    const out = reconcile(ledger, { revenue: 500, cogs: 0, operatingTotal: 200, netProfit: 300 });
    assert.equal(out.agrees, false);
    const cogs = out.lines.find((l) => l.label === "Cost of sales");
    assert.equal(cogs.difference, 300);
    assert.equal(cogs.agrees, false);
    assert.equal(out.lines.find((l) => l.label === "Revenue").agrees, true);
  });
});
