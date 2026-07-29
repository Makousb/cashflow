// Builds the three core financial statements from a business's figures.
// Cash basis: the ledger holds actual cash movements, so cash on hand is
// income received minus expenses paid. Receivables/payables are the accrual
// side (invoiced or billed but not yet settled).

const COGS_CATEGORY = "Cost of Goods";

// Income Statement: revenue − COGS = gross profit; − operating expenses = net.
export function incomeStatement(revenue, byCategory) {
  const cogs = byCategory
    .filter((c) => c.category === COGS_CATEGORY)
    .reduce((s, c) => s + Number(c.total), 0);

  const operating = byCategory
    .filter((c) => c.category !== COGS_CATEGORY)
    .map((c) => ({ category: c.category, total: Number(c.total) }));

  const operatingTotal = operating.reduce((s, c) => s + c.total, 0);
  const grossProfit = revenue - cogs;

  return {
    revenue,
    cogs,
    grossProfit,
    operating,
    operatingTotal,
    netProfit: grossProfit - operatingTotal
  };
}

// Balance Sheet: Assets = Liabilities + Equity (equity is the residual).
export function balanceSheet({ cash, receivable, inventory, payable }) {
  const totalAssets = cash + receivable + inventory;
  const totalLiabilities = payable;
  const equity = totalAssets - totalLiabilities;

  return {
    assets: { cash, receivable, inventory, total: totalAssets },
    liabilities: { payable, total: totalLiabilities },
    equity,
    balanced: Math.abs(totalAssets - (totalLiabilities + equity)) < 0.01
  };
}

// Cash Flow Statement (operating, cash basis): cash in − cash out.
export function cashFlow(revenue, byCategory) {
  const outflows = byCategory.map((c) => ({
    category: c.category,
    total: Number(c.total)
  }));
  const outflowTotal = outflows.reduce((s, c) => s + c.total, 0);

  return {
    inflows: revenue,
    outflows,
    outflowTotal,
    netOperating: revenue - outflowTotal
  };
}
