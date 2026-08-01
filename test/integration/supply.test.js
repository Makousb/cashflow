import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  addMessage,
  advanceOrder,
  createSupplyOrder,
  deliveryHistory,
  getOrder,
  listMessages,
  listOrdersFor,
  receiveSupplyOrder,
  requestPartnership,
  setPartnershipStatus,
  shipSupplyOrder,
  supplierCatalog
} from "../../db/queries/supply.js";
import { toISODate } from "../../utils/dates.js";
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

describe("an order between two businesses", { skip: skipWithoutDb }, () => {
  let user;
  let buyer;
  let seller;
  let theirSugar;
  let mySugar;

  before(async () => {
    user = await makeUser("supply");
    buyer = await makeBusiness(user.id, "Buyer Shop");
    seller = await makeBusiness(user.id, "Seller Depot", { isSupplier: true, leadTimeDays: 2 });
    theirSugar = await makeProduct(seller.id, user.id, {
      name: "Sugar 2kg", sku: "SUG-2KG", quantity: 500, unitCost: 195, salePrice: 220
    });
    mySugar = await makeProduct(buyer.id, user.id, {
      name: "Sugar 2kg", quantity: 4, unitCost: 220, salePrice: 260
    });
    await requestPartnership({
      buyerBusinessId: buyer.id, supplierBusinessId: seller.id,
      requestedBy: user.id, status: "active"
    });
  });

  after(async () => {
    await dropUser(user?.id);
  });

  async function placeOrder(lines) {
    return createSupplyOrder({
      buyerBusinessId: buyer.id, buyerUserId: user.id,
      supplierBusinessId: seller.id, supplierUserId: user.id,
      currency: "KES", placedOn: "2026-05-01", expectedOn: "2026-05-03",
      items: lines
    });
  }

  test("the catalog is the supplier's own stock", async () => {
    const catalog = await supplierCatalog(seller.id);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].name, "Sugar 2kg");
    assert.equal(Number(catalog[0].sale_price), 220);
  });

  test("placing one totals the lines", async () => {
    const order = await placeOrder([
      { supplierProductId: theirSugar.id, name: "Sugar 2kg", sku: "SUG-2KG",
        quantity: 20, unitPrice: 220 }
    ]);
    assert.equal(order.status, "placed");
    assert.equal(Number(order.total), 4400);
  });

  test("both sides see it", async () => {
    const order = await placeOrder([
      { supplierProductId: theirSugar.id, name: "Sugar 2kg", quantity: 5, unitPrice: 220 }
    ]);
    const asBuyer = (await listOrdersFor(buyer.id)).find((o) => o.id === order.id);
    const asSeller = (await listOrdersFor(seller.id)).find((o) => o.id === order.id);
    assert.equal(asBuyer.role, "buyer");
    assert.equal(asSeller.role, "supplier");
  });

  test("only the supplier's stock moves when it ships", async () => {
    const order = await placeOrder([
      { supplierProductId: theirSugar.id, name: "Sugar 2kg", quantity: 10, unitPrice: 220 }
    ]);
    const theirsBefore = await stockOf(theirSugar.id);
    const mineBefore = await stockOf(mySugar.id);

    const shipped = await shipSupplyOrder(order.id, "KBZ 442K");
    assert.equal(shipped.status, "shipped");
    assert.equal(shipped.tracking, "KBZ 442K");
    assert.equal(await stockOf(theirSugar.id), theirsBefore - 10);
    assert.equal(await stockOf(mySugar.id), mineBefore, "the buyer gets it on receipt, not dispatch");
  });

  test("receiving puts it on the buyer's shelves", async () => {
    const order = await placeOrder([
      { supplierProductId: theirSugar.id, name: "Sugar 2kg", quantity: 6, unitPrice: 220 }
    ]);
    await shipSupplyOrder(order.id, null);
    const mineBefore = await stockOf(mySugar.id);

    const result = await receiveSupplyOrder(order.id);
    assert.equal(result.order.status, "received");
    assert.equal(await stockOf(mySugar.id), mineBefore + 6);
  });

  test("an item the buyer has never stocked is created for them", async () => {
    const rice = await makeProduct(seller.id, user.id, {
      name: "Rice 5kg", sku: "RCE-5KG", quantity: 100, unitCost: 690, salePrice: 780
    });
    const order = await placeOrder([
      { supplierProductId: rice.id, name: "Rice 5kg", sku: "RCE-5KG",
        quantity: 4, unitPrice: 780 }
    ]);
    await shipSupplyOrder(order.id, null);
    await receiveSupplyOrder(order.id);

    const created = await one(
      "SELECT * FROM products WHERE business_id = $1 AND name = 'Rice 5kg'", [buyer.id]
    );
    assert.ok(created, "the buyer should now stock it");
    assert.equal(Number(created.quantity), 4);
    assert.equal(Number(created.unit_cost), 780);
  });

  test("the carrying cost follows the price just paid", async () => {
    const order = await placeOrder([
      { supplierProductId: theirSugar.id, name: "Sugar 2kg", quantity: 2, unitPrice: 240 }
    ]);
    await shipSupplyOrder(order.id, null);
    await receiveSupplyOrder(order.id);
    const product = await one("SELECT unit_cost FROM products WHERE id = $1", [mySugar.id]);
    assert.equal(Number(product.unit_cost), 240);
  });

  test("it cannot be received twice", async () => {
    const order = await placeOrder([
      { supplierProductId: theirSugar.id, name: "Sugar 2kg", quantity: 3, unitPrice: 220 }
    ]);
    await shipSupplyOrder(order.id, null);
    await receiveSupplyOrder(order.id);

    const stock = await stockOf(mySugar.id);
    assert.equal(await receiveSupplyOrder(order.id), null);
    assert.equal(await stockOf(mySugar.id), stock, "a repeat must not restock");
  });

  test("it cannot ship after it has already gone", async () => {
    const order = await placeOrder([
      { supplierProductId: theirSugar.id, name: "Sugar 2kg", quantity: 1, unitPrice: 220 }
    ]);
    await shipSupplyOrder(order.id, null);
    const theirs = await stockOf(theirSugar.id);
    assert.equal(await shipSupplyOrder(order.id, null), null);
    assert.equal(await stockOf(theirSugar.id), theirs, "a repeat must not deduct again");
  });
});

describe("moving an order along", { skip: skipWithoutDb }, () => {
  let user;
  let buyer;
  let seller;

  before(async () => {
    user = await makeUser("advance");
    buyer = await makeBusiness(user.id, "Advance Buyer");
    seller = await makeBusiness(user.id, "Advance Seller", { isSupplier: true });
  });

  after(async () => {
    await dropUser(user?.id);
  });

  const place = () =>
    createSupplyOrder({
      buyerBusinessId: buyer.id, buyerUserId: user.id,
      supplierBusinessId: seller.id, supplierUserId: user.id,
      currency: "KES", placedOn: "2026-05-01", expectedOn: "2026-05-03",
      items: [{ name: "Something", quantity: 1, unitPrice: 100 }]
    });

  test("confirming records the date the supplier committed to", async () => {
    const order = await place();
    const confirmed = await advanceOrder(order.id, {
      from: ["placed"], status: "confirmed", stampColumn: "confirmed_at",
      fields: { promised_on: "2026-05-06" }
    });
    assert.equal(confirmed.status, "confirmed");
    assert.ok(confirmed.confirmed_at);
    // toISOString would shift the day for anyone east of UTC — a DATE column
    // comes back as local midnight. This is why toISODate exists.
    assert.equal(toISODate(confirmed.promised_on), "2026-05-06");
  });

  test("a stage can only be reached from the right one", async () => {
    const order = await place();
    // Nothing has shipped, so it cannot be delivered.
    const jumped = await advanceOrder(order.id, {
      from: ["shipped"], status: "delivered", stampColumn: "delivered_at"
    });
    assert.equal(jumped, null);
    const unchanged = await getOrder(order.id);
    assert.equal(unchanged.status, "placed");
  });

  test("a cancelled order stays cancelled", async () => {
    const order = await place();
    await advanceOrder(order.id, {
      from: ["placed", "confirmed"], status: "cancelled", stampColumn: "closed_at"
    });
    const revived = await advanceOrder(order.id, {
      from: ["placed"], status: "confirmed", stampColumn: "confirmed_at"
    });
    assert.equal(revived, null);
  });

  test("delivery history only counts orders that arrived", async () => {
    const order = await place();
    await shipSupplyOrder(order.id, null);
    assert.equal((await deliveryHistory(buyer.id, seller.id)).length, 0);

    await advanceOrder(order.id, {
      from: ["shipped"], status: "delivered", stampColumn: "delivered_at"
    });
    const history = await deliveryHistory(buyer.id, seller.id);
    assert.equal(history.length, 1);
    assert.ok(history[0].delivered_at);
  });
});

describe("the order thread", { skip: skipWithoutDb }, () => {
  let user;
  let buyer;
  let seller;
  let order;

  before(async () => {
    user = await makeUser("thread");
    buyer = await makeBusiness(user.id, "Thread Buyer");
    seller = await makeBusiness(user.id, "Thread Seller", { isSupplier: true });
    order = await createSupplyOrder({
      buyerBusinessId: buyer.id, buyerUserId: user.id,
      supplierBusinessId: seller.id, supplierUserId: user.id,
      currency: "KES", placedOn: "2026-05-01", expectedOn: "2026-05-03",
      items: [{ name: "Something", quantity: 1, unitPrice: 100 }]
    });
  });

  after(async () => {
    await dropUser(user?.id);
  });

  test("carries chat and status events together, in order", async () => {
    await addMessage({ orderId: order.id, businessId: buyer.id, userId: user.id,
      kind: "event", body: "Order placed." });
    await addMessage({ orderId: order.id, businessId: seller.id, userId: user.id,
      body: "On its way." });

    const thread = await listMessages(order.id);
    assert.equal(thread.length, 2);
    assert.deepEqual(thread.map((m) => m.kind), ["event", "message"]);
    assert.equal(thread[1].business_name, "Thread Seller");
    assert.ok(thread[1].user_name, "the sender should be named");
  });

  test("messages go when the order goes", async () => {
    await q("DELETE FROM supply_orders WHERE id = $1", [order.id]);
    assert.equal((await listMessages(order.id)).length, 0);
  });
});

// One teardown for the whole file — every suite in it shares the same pool.
after(async () => {
  await closePool();
});
