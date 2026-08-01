import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  balanceSheet,
  cashFlow,
  costOfGoodsSold,
  incomeStatement
} from "../../utils/statements.js";

describe("costOfGoodsSold", () => {
  test("charges only the stock that left the shelves", () => {
    const result = costOfGoodsSold({ purchases: 1000, closingInventory: 300 });
    assert.equal(result.cogs, 700);
    assert.equal(result.relief, 300);
    assert.equal(result.unpurchasedStock, false);
  });

  test("charges everything when nothing is left", () => {
    assert.equal(costOfGoodsSold({ purchases: 1000, closingInventory: 0 }).cogs, 1000);
  });

  test("charges nothing when none of it sold", () => {
    assert.equal(costOfGoodsSold({ purchases: 1000, closingInventory: 1000 }).cogs, 0);
  });

  test("counts opening stock as available to sell", () => {
    // 200 on hand plus 800 bought, 500 left: 500 of it was sold.
    const result = costOfGoodsSold({
      purchases: 800, openingInventory: 200, closingInventory: 500
    });
    assert.equal(result.cogs, 500);
  });

  test("stock entered by hand cannot drive the cost negative", () => {
    // Someone typed in a starting quantity that was never bought through the
    // ledger. Relieving the full value would report a negative cost.
    const result = costOfGoodsSold({ purchases: 0, closingInventory: 500 });
    assert.equal(result.cogs, 0);
    assert.equal(result.unpurchasedStock, true);
  });

  test("drawing stock down below where it opened does not add cost back", () => {
    const result = costOfGoodsSold({
      purchases: 100, openingInventory: 500, closingInventory: 200
    });
    assert.equal(result.relief, 0);
    assert.equal(result.cogs, 100);
  });
});

describe("incomeStatement", () => {
  const books = [
    { category: "Inventory Purchase", total: 400 },
    { category: "Rent", total: 200 },
    { category: "Payroll", total: 150 }
  ];

  test("stock purchases are not operating expenses", () => {
    const statement = incomeStatement(1000, books, { closingInventory: 100 });
    assert.equal(statement.operatingTotal, 350);
    assert.deepEqual(statement.operating.map((o) => o.category), ["Rent", "Payroll"]);
  });

  test("pools the category's old name so existing books still read", () => {
    const statement = incomeStatement(
      1000,
      [{ category: "Cost of Goods", total: 100 }, { category: "Inventory Purchase", total: 400 }],
      { closingInventory: 0 }
    );
    assert.equal(statement.stock.purchases, 500);
    assert.equal(statement.cogs, 500);
    assert.equal(statement.operatingTotal, 0);
  });

  test("gross profit is revenue less what sold", () => {
    const statement = incomeStatement(1000, books, { closingInventory: 100 });
    assert.equal(statement.cogs, 300);
    assert.equal(statement.grossProfit, 700);
  });

  test("net profit is gross profit less running costs", () => {
    const statement = incomeStatement(1000, books, { closingInventory: 100 });
    assert.equal(statement.netProfit, 350);
  });

  test("buying stock that has not sold does not reduce profit", () => {
    const before = incomeStatement(1000, [{ category: "Rent", total: 200 }], {
      closingInventory: 0
    });
    const after = incomeStatement(
      1000,
      [{ category: "Rent", total: 200 }, { category: "Inventory Purchase", total: 500 }],
      { closingInventory: 500 }
    );
    assert.equal(after.netProfit, before.netProfit);
  });

  test("selling that stock is what charges it to profit", () => {
    const statement = incomeStatement(
      1000,
      [{ category: "Rent", total: 200 }, { category: "Inventory Purchase", total: 500 }],
      { closingInventory: 200 }
    );
    assert.equal(statement.cogs, 300);
    assert.equal(statement.netProfit, 500);
  });

  test("copes with empty books", () => {
    const statement = incomeStatement(0, [], {});
    assert.equal(statement.cogs, 0);
    assert.equal(statement.grossProfit, 0);
    assert.equal(statement.netProfit, 0);
    assert.deepEqual(statement.operating, []);
  });

  test("reports a loss when costs exceed revenue", () => {
    const statement = incomeStatement(100, [{ category: "Rent", total: 400 }], {});
    assert.equal(statement.netProfit, -300);
  });
});

describe("balanceSheet", () => {
  test("assets equal liabilities plus equity", () => {
    const sheet = balanceSheet({
      cash: 1000, receivable: 250, inventory: 400, payable: 300
    });
    assert.equal(sheet.assets.total, 1650);
    assert.equal(sheet.liabilities.total, 300);
    assert.equal(sheet.equity, 1350);
    assert.equal(sheet.balanced, true);
  });

  test("equity goes negative when the business owes more than it holds", () => {
    const sheet = balanceSheet({ cash: 100, receivable: 0, inventory: 0, payable: 500 });
    assert.equal(sheet.equity, -400);
    assert.equal(sheet.balanced, true);
  });

  test("balances on an empty business", () => {
    const sheet = balanceSheet({ cash: 0, receivable: 0, inventory: 0, payable: 0 });
    assert.equal(sheet.balanced, true);
  });
});

describe("cashFlow", () => {
  test("nets cash in against cash out", () => {
    const flow = cashFlow(1000, [
      { category: "Rent", total: 200 },
      { category: "Inventory Purchase", total: 500 }
    ]);
    assert.equal(flow.outflowTotal, 700);
    assert.equal(flow.netOperating, 300);
  });

  test("stock purchases count in full, unlike on the income statement", () => {
    const books = [{ category: "Inventory Purchase", total: 500 }];
    const flow = cashFlow(1000, books);
    const statement = incomeStatement(1000, books, { closingInventory: 500 });
    assert.equal(flow.outflowTotal, 500);
    assert.equal(statement.cogs, 0);
  });
});
