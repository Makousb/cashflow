// Builds the three core financial statements from a business's figures.
//
// The ledger records cash movements, so the balance sheet's cash and the whole
// cash flow statement are cash basis. The income statement is not: buying stock
// is not a cost, it swaps cash for an asset, and that stock only becomes a cost
// when it is sold. Keeping those two views apart is the point of having both.

// Ledger categories that buy stock rather than spend on running the business.
// "Cost of Goods" is the name these postings carried before the split, kept
// here so books written under it keep reading correctly.
const INVENTORY_CATEGORIES = ["Inventory Purchase", "Cost of Goods"];

// Cost of goods SOLD, the periodic way: everything bought for the shelves,
// less whatever is still sitting on them. No per-sale costing required, which
// matters because revenue can be recorded straight into the ledger without
// going through the sales module.
//
// openingInventory is the stock held when the books opened. Cashflow starts
// its businesses from zero, so stock typed in by hand as a starting quantity
// has no purchase behind it; the relief is capped at purchases so that can
// never drive the cost negative, and `unpurchasedStock` flags when it bites.
export function costOfGoodsSold({ purchases, closingInventory, openingInventory = 0 }) {
  const heldBack = closingInventory - openingInventory;
  const relief = Math.min(Math.max(heldBack, 0), purchases);
  return {
    purchases,
    openingInventory,
    closingInventory,
    relief,
    cogs: purchases - relief,
    unpurchasedStock: heldBack > purchases
  };
}

// Income Statement: revenue − COGS = gross profit; − operating expenses = net.
export function incomeStatement(revenue, byCategory, inventory = {}) {
  const purchases = byCategory
    .filter((c) => INVENTORY_CATEGORIES.includes(c.category))
    .reduce((s, c) => s + Number(c.total), 0);

  const stock = costOfGoodsSold({
    purchases,
    closingInventory: Number(inventory.closingInventory) || 0,
    openingInventory: Number(inventory.openingInventory) || 0
  });

  const operating = byCategory
    .filter((c) => !INVENTORY_CATEGORIES.includes(c.category))
    .map((c) => ({ category: c.category, total: Number(c.total) }));

  const operatingTotal = operating.reduce((s, c) => s + c.total, 0);
  const grossProfit = revenue - stock.cogs;

  return {
    revenue,
    cogs: stock.cogs,
    stock,
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
