import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { createSale, listSales, salesSummary, voidSale } from "../../db/queries/sales.js";
import { monthStart, toISODate, today } from "../../utils/dates.js";
import {
  closePool,
  dropUser,
  makeBusiness,
  makeProduct,
  makeUser,
  one,
  q,
  skipWithoutDb,
  stockOf
} from "./helpers.js";

describe("recording a sale", { skip: skipWithoutDb }, () => {
  let user;
  let shop;
  let sugar;
  let milk;

  before(async () => {
    user = await makeUser("sales");
    shop = await makeBusiness(user.id, "Test Grocer");
    sugar = await makeProduct(shop.id, user.id, {
      name: "Sugar 2kg", sku: "SUG", quantity: 10, unitCost: 200, salePrice: 260
    });
    milk = await makeProduct(shop.id, user.id, {
      name: "Milk 1L", quantity: 20, unitCost: 50, salePrice: 70
    });
  });

  after(async () => {
    await dropUser(user?.id);
  });

  test("takes the units off the shelf", async () => {
    const before = await stockOf(sugar.id);
    const { sale } = await createSale({
      businessId: shop.id, userId: user.id, payment: "cash",
      occurredOn: "2026-05-01", lines: [{ productId: sugar.id, name: "Sugar 2kg", quantity: 3 }]
    });
    assert.equal(await stockOf(sugar.id), before - 3);
    assert.equal(Number(sale.total), 780);
  });

  test("records what those units cost, so the margin is real", async () => {
    const { sale } = await createSale({
      businessId: shop.id, userId: user.id, payment: "cash",
      occurredOn: "2026-05-01", lines: [{ productId: milk.id, name: "Milk 1L", quantity: 4 }]
    });
    assert.equal(Number(sale.total), 280);
    assert.equal(Number(sale.cost_total), 200);
  });

  test("books the money as income", async () => {
    const { sale } = await createSale({
      businessId: shop.id, userId: user.id, payment: "cash",
      occurredOn: "2026-05-02", lines: [{ productId: milk.id, name: "Milk 1L", quantity: 2 }]
    });
    const tx = await one("SELECT * FROM business_transactions WHERE id = $1",
      [sale.transaction_id]);
    assert.equal(tx.kind, "income");
    assert.equal(tx.category, "Sales");
    assert.equal(Number(tx.amount), Number(sale.total));
  });

  test("does not post a second entry for the cost", async () => {
    // The books are cash basis and already expense stock when it is bought;
    // charging it again here would count the same goods twice.
    const { sale } = await createSale({
      businessId: shop.id, userId: user.id, payment: "cash",
      occurredOn: "2026-05-03", lines: [{ productId: milk.id, name: "Milk 1L", quantity: 1 }]
    });
    const rows = await q(
      "SELECT kind FROM business_transactions WHERE note = $1", [`Sale #${sale.id}`]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "income");
  });

  test("refuses to sell more than is there, and names what is short", async () => {
    const before = await stockOf(sugar.id);
    const result = await createSale({
      businessId: shop.id, userId: user.id, payment: "cash",
      occurredOn: "2026-05-04",
      lines: [{ productId: sugar.id, name: "Sugar 2kg", quantity: before + 5 }]
    });
    assert.ok(result.shortfalls, "expected a shortfall, not a sale");
    assert.equal(result.shortfalls[0].name, "Sugar 2kg");
    assert.equal(result.shortfalls[0].available, before);
    assert.equal(await stockOf(sugar.id), before, "stock must not move");
  });

  test("a refused sale leaves nothing behind at all", async () => {
    const countBefore = (await listSales(shop.id, user.id)).length;
    await createSale({
      businessId: shop.id, userId: user.id, payment: "cash", occurredOn: "2026-05-04",
      lines: [
        { productId: milk.id, name: "Milk 1L", quantity: 1 },
        { productId: sugar.id, name: "Sugar 2kg", quantity: 9999 }
      ]
    });
    assert.equal((await listSales(shop.id, user.id)).length, countBefore,
      "the whole sale rolls back, including the line that was fine");
  });

  test("an off-catalog line sells without touching stock", async () => {
    const { sale } = await createSale({
      businessId: shop.id, userId: user.id, payment: "cash", occurredOn: "2026-05-05",
      lines: [{ productId: null, name: "Delivery", quantity: 1, unitPrice: 250 }]
    });
    assert.equal(Number(sale.total), 250);
    assert.equal(Number(sale.cost_total), 0);
  });
});

describe("selling on credit", { skip: skipWithoutDb }, () => {
  let user;
  let shop;
  let product;

  before(async () => {
    user = await makeUser("credit");
    shop = await makeBusiness(user.id, "Credit Shop");
    product = await makeProduct(shop.id, user.id, {
      name: "Rice 5kg", quantity: 30, unitCost: 700, salePrice: 900
    });
  });

  after(async () => {
    await dropUser(user?.id);
  });

  test("raises a receivable instead of booking income", async () => {
    const { sale } = await createSale({
      businessId: shop.id, userId: user.id, payment: "credit",
      customer: "Kariuki Hotel", occurredOn: "2026-05-01", dueOn: "2026-05-15",
      lines: [{ productId: product.id, name: "Rice 5kg", quantity: 5 }]
    });

    assert.equal(sale.transaction_id, null, "no income yet");
    assert.ok(sale.invoice_id, "an invoice should exist");

    const invoice = await one("SELECT * FROM invoices WHERE id = $1", [sale.invoice_id]);
    assert.equal(invoice.status, "unpaid");
    assert.equal(invoice.customer, "Kariuki Hotel");
    assert.equal(Number(invoice.amount), 4500);
  });

  test("the stock still leaves, paid or not", async () => {
    const before = await stockOf(product.id);
    await createSale({
      businessId: shop.id, userId: user.id, payment: "credit",
      occurredOn: "2026-05-02", dueOn: "2026-05-16",
      lines: [{ productId: product.id, name: "Rice 5kg", quantity: 2 }]
    });
    assert.equal(await stockOf(product.id), before - 2);
  });
});

describe("voiding a sale", { skip: skipWithoutDb }, () => {
  let user;
  let shop;
  let product;

  before(async () => {
    user = await makeUser("void");
    shop = await makeBusiness(user.id, "Void Shop");
    product = await makeProduct(shop.id, user.id, {
      name: "Bread", quantity: 50, unitCost: 40, salePrice: 60
    });
  });

  after(async () => {
    await dropUser(user?.id);
  });

  test("puts the stock back and unbooks the money", async () => {
    const before = await stockOf(product.id);
    const { sale } = await createSale({
      businessId: shop.id, userId: user.id, payment: "cash", occurredOn: "2026-05-01",
      lines: [{ productId: product.id, name: "Bread", quantity: 10 }]
    });
    assert.equal(await stockOf(product.id), before - 10);

    const result = await voidSale(sale.id, user.id);
    assert.ok(result.sale);
    assert.equal(await stockOf(product.id), before);
    assert.equal(
      (await q("SELECT id FROM business_transactions WHERE id = $1", [sale.transaction_id])).length,
      0
    );
    assert.equal((await q("SELECT id FROM sales WHERE id = $1", [sale.id])).length, 0);
    assert.equal((await q("SELECT id FROM sale_items WHERE sale_id = $1", [sale.id])).length, 0);
  });

  test("refuses once the customer has paid", async () => {
    const { sale } = await createSale({
      businessId: shop.id, userId: user.id, payment: "credit", occurredOn: "2026-05-02",
      dueOn: "2026-05-16", lines: [{ productId: product.id, name: "Bread", quantity: 5 }]
    });
    await q("UPDATE invoices SET status = 'paid' WHERE id = $1", [sale.invoice_id]);

    const before = await stockOf(product.id);
    const result = await voidSale(sale.id, user.id);

    assert.equal(result.settled, true);
    assert.equal(await stockOf(product.id), before, "stock must not move");
    assert.equal((await q("SELECT id FROM sales WHERE id = $1", [sale.id])).length, 1);
  });

  test("reports a sale that is not there", async () => {
    assert.equal((await voidSale(9999999, user.id)).missing, true);
  });

  test("will not void another user's sale", async () => {
    const other = await makeUser("void-other");
    const { sale } = await createSale({
      businessId: shop.id, userId: user.id, payment: "cash", occurredOn: "2026-05-03",
      lines: [{ productId: product.id, name: "Bread", quantity: 1 }]
    });
    assert.equal((await voidSale(sale.id, other.id)).missing, true);
    await dropUser(other.id);
  });
});

describe("the sales summary", { skip: skipWithoutDb }, () => {
  let user;
  let shop;

  before(async () => {
    user = await makeUser("summary");
    shop = await makeBusiness(user.id, "Summary Shop");
    const product = await makeProduct(shop.id, user.id, {
      name: "Tea 500g", quantity: 100, unitCost: 100, salePrice: 150
    });
    // The summary filters on CURRENT_DATE, which Postgres reads in the server's
    // local timezone — so the sales have to be dated the same way. toISOString
    // would give the UTC date, which is still yesterday east of UTC after
    // midnight, and the sales would land outside the day being counted.
    const occurredOn = today();
    for (const quantity of [2, 3]) {
      await createSale({
        businessId: shop.id, userId: user.id, payment: "cash", occurredOn,
        lines: [{ productId: product.id, name: "Tea 500g", quantity }]
      });
    }
  });

  after(async () => {
    await dropUser(user?.id);
  });

  test("adds up today's takings and their cost", async () => {
    const summary = await salesSummary(shop.id, user.id);
    assert.equal(summary.today_count, 2);
    assert.equal(Number(summary.today_total), 750);
    assert.equal(Number(summary.all_cost), 500);
  });

  test("today's takings count towards the month as well", async () => {
    const summary = await salesSummary(shop.id, user.id);
    assert.equal(summary.month_count, 2);
    assert.equal(Number(summary.month_total), 750);
    assert.equal(Number(summary.month_cost), 500);
  });
});

describe("the sales summary at the turn of the month", { skip: skipWithoutDb }, () => {
  let user;
  let shop;

  before(async () => {
    user = await makeUser("summary-month");
    shop = await makeBusiness(user.id, "Month Boundary Shop");
    const product = await makeProduct(shop.id, user.id, {
      name: "Tea 500g", quantity: 100, unitCost: 100, salePrice: 150
    });
    // The month figures start at date_trunc('month', CURRENT_DATE), an inclusive
    // bound Postgres reads in its local timezone — so these two straddle it,
    // dated from local components for the same reason the day fixture above is.
    const now = new Date();
    const firstOfThisMonth = monthStart(now);
    // Day 0 of this month is the last day of the one before it.
    const lastOfLastMonth = toISODate(new Date(now.getFullYear(), now.getMonth(), 0));

    for (const [occurredOn, quantity] of [[firstOfThisMonth, 4], [lastOfLastMonth, 6]]) {
      await createSale({
        businessId: shop.id, userId: user.id, payment: "cash", occurredOn,
        lines: [{ productId: product.id, name: "Tea 500g", quantity }]
      });
    }
  });

  after(async () => {
    await dropUser(user?.id);
  });

  test("the first of the month is in, and nothing before it is", async () => {
    const summary = await salesSummary(shop.id, user.id);
    assert.equal(summary.month_count, 1, "last month's sale must not be counted");
    assert.equal(Number(summary.month_total), 600);
    assert.equal(Number(summary.month_cost), 400);
  });

  test("last month's sale is still there in the all-time figures", async () => {
    const summary = await salesSummary(shop.id, user.id);
    assert.equal(summary.all_count, 2);
    assert.equal(Number(summary.all_total), 1500);
    assert.equal(Number(summary.all_cost), 1000);
  });
});

// One teardown for the whole file — every suite in it shares the same pool.
after(async () => {
  await closePool();
});
