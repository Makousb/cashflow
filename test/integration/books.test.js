import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  addBusinessTransaction,
  businessPnL,
  createBusiness
} from "../../db/queries/business.js";
import { inventorySummary } from "../../db/queries/inventory.js";
import { outstandingTotals } from "../../db/queries/accounting.js";
import { balanceSheet, incomeStatement } from "../../utils/statements.js";
import {
  closePool,
  dropUser,
  makeBusiness,
  makeProduct,
  makeUser,
  skipWithoutDb
} from "./helpers.js";

// Ties the ledger to the statements: the pure functions are unit-tested, this
// checks they are being fed what they expect.
describe("the books end to end", { skip: skipWithoutDb }, () => {
  let user;
  let shop;

  before(async () => {
    user = await makeUser("books");
    shop = await makeBusiness(user.id, "Books Shop");

    const post = (kind, amount, category) =>
      addBusinessTransaction({
        businessId: shop.id, userId: user.id, kind, amount, category,
        note: null, occurredOn: "2026-05-01"
      });

    await post("income", 10000, "Sales");
    await post("expense", 6000, "Inventory Purchase");
    await post("expense", 1500, "Rent");
    await post("expense", 500, "Utilities");

    // 2000 of the stock bought is still on the shelf.
    await makeProduct(shop.id, user.id, {
      name: "Held stock", quantity: 10, unitCost: 200, salePrice: 300
    });
  });

  after(async () => {
    await dropUser(user?.id);
  });

  test("the ledger totals up", async () => {
    const pnl = await businessPnL(shop.id, user.id);
    assert.equal(pnl.revenue, 10000);
    assert.equal(pnl.expenses, 8000);
    assert.equal(pnl.net, 2000);
  });

  test("only the stock that sold is charged to profit", async () => {
    const pnl = await businessPnL(shop.id, user.id);
    const stock = await inventorySummary(shop.id, user.id);
    const statement = incomeStatement(pnl.revenue, pnl.byCategory, {
      closingInventory: Number(stock.stock_value)
    });

    assert.equal(Number(stock.stock_value), 2000);
    assert.equal(statement.stock.purchases, 6000);
    assert.equal(statement.cogs, 4000);
    assert.equal(statement.grossProfit, 6000);
  });

  test("running costs stay separate from stock", async () => {
    const pnl = await businessPnL(shop.id, user.id);
    const stock = await inventorySummary(shop.id, user.id);
    const statement = incomeStatement(pnl.revenue, pnl.byCategory, {
      closingInventory: Number(stock.stock_value)
    });

    assert.equal(statement.operatingTotal, 2000);
    assert.ok(!statement.operating.some((o) => o.category === "Inventory Purchase"));
  });

  test("accrual profit is above cash by the value of unsold stock", async () => {
    const pnl = await businessPnL(shop.id, user.id);
    const stock = await inventorySummary(shop.id, user.id);
    const statement = incomeStatement(pnl.revenue, pnl.byCategory, {
      closingInventory: Number(stock.stock_value)
    });

    assert.equal(statement.netProfit, pnl.net + Number(stock.stock_value));
  });

  test("the balance sheet balances on real figures", async () => {
    const pnl = await businessPnL(shop.id, user.id);
    const stock = await inventorySummary(shop.id, user.id);
    const outstanding = await outstandingTotals(shop.id, user.id);

    const sheet = balanceSheet({
      cash: pnl.net,
      receivable: outstanding.receivable,
      inventory: Number(stock.stock_value),
      payable: outstanding.payable
    });

    assert.equal(sheet.balanced, true);
    assert.equal(sheet.assets.total, sheet.liabilities.total + sheet.equity);
  });
});

describe("creating a business", { skip: skipWithoutDb }, () => {
  let user;

  before(async () => {
    user = await makeUser("create-business");
  });

  after(async () => {
    await dropUser(user?.id);
  });

  test("comes back with the row, not undefined", async () => {
    // It used to stamp the share code with a data-modifying CTE, which cannot
    // see its own insert — so this returned nothing and creation threw.
    const business = await createBusiness({
      userId: user.id, name: "Brand New Shop", industry: "Retail"
    });
    assert.ok(business, "createBusiness must return the row");
    assert.equal(business.name, "Brand New Shop");
  });

  test("can be traded with immediately, without a restart", async () => {
    const business = await createBusiness({
      userId: user.id, name: "Contactable Shop", industry: "Retail"
    });
    assert.match(business.supply_code || "", /^MT-[0-9A-F]{6}$/);
  });

  test("every business gets its own code", async () => {
    const one = await createBusiness({ userId: user.id, name: "A", industry: null });
    const two = await createBusiness({ userId: user.id, name: "B", industry: null });
    assert.notEqual(one.supply_code, two.supply_code);
  });
});

// One teardown for the whole file — every suite in it shares the same pool.
after(async () => {
  await closePool();
});
