import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  createLocation,
  ensureDefaultLocation,
  heldAt,
  listLocations,
  listTransfers,
  makeDefault,
  placeUnplaced,
  stockRows,
  transferStock
} from "../../db/queries/warehouse.js";
import { createSale, voidSale } from "../../db/queries/sales.js";
import { listProducts, receivePurchaseOrder } from "../../db/queries/inventory.js";
import { stockReport } from "../../utils/warehouse.js";
import { closePool, dropUser, makeBusiness, makeProduct, makeUser, one, q, skipWithoutDb, stockOf } from "./helpers.js";

const TODAY = "2026-08-11";

// The invariant the whole design rests on: however stock moved, what is placed
// adds up to what is owned.
async function assertPlacementsMatchTotals(businessId, userId, note) {
  const [products, rows] = await Promise.all([
    listProducts(businessId, userId),
    stockRows(businessId, userId)
  ]);
  const report = stockReport(products, rows, await listLocations(businessId, userId));
  for (const row of report.rows) {
    assert.equal(
      row.unplaced, 0,
      `${note}: ${row.product.name} has ${row.total} on hand but ${row.placed} placed`
    );
  }
  return report;
}

describe("opening locations", { skip: skipWithoutDb }, () => {
  let user;
  let business;

  before(async () => {
    user = await makeUser("wh-open");
    business = await makeBusiness(user.id, "Store Co");
  });
  after(async () => { await dropUser(user?.id); });

  test("a business gets a main store on demand", async () => {
    const location = await ensureDefaultLocation(business.id, user.id);
    assert.equal(location.is_default, true);
    assert.equal(location.name, "Main store");
  });

  test("asking again returns the same one rather than a second", async () => {
    await ensureDefaultLocation(business.id, user.id);
    const locations = await listLocations(business.id, user.id);
    assert.equal(locations.filter((l) => l.is_default).length, 1);
  });

  test("only one location can be the default", async () => {
    const stall = await createLocation({
      businessId: business.id, userId: user.id, name: "Market stall", code: "STALL"
    });
    await makeDefault({ locationId: stall.id, businessId: business.id, userId: user.id });

    const locations = await listLocations(business.id, user.id);
    assert.equal(locations.filter((l) => l.is_default).length, 1);
    assert.equal(locations.find((l) => l.is_default).id, stall.id);
  });
});

describe("stock following the total wherever it goes", { skip: skipWithoutDb }, () => {
  let user;
  let business;
  let product;
  let main;

  before(async () => {
    user = await makeUser("wh-invariant");
    business = await makeBusiness(user.id, "Moving Co");
    main = await ensureDefaultLocation(business.id, user.id);
    product = await makeProduct(business.id, user.id, {
      name: "Sugar", quantity: 0, unitCost: 30, salePrice: 50, reorderPoint: 5
    });
  });
  after(async () => { await dropUser(user?.id); });

  test("receiving a purchase order places what arrived", async () => {
    const order = await one(
      `INSERT INTO purchase_orders (business_id, user_id, supplier, total)
       VALUES ($1, $2, 'Wholesaler', 3000) RETURNING *`,
      [business.id, user.id]
    );
    await q(
      `INSERT INTO purchase_order_items (po_id, product_id, name, quantity, unit_cost)
       VALUES ($1, $2, 'Sugar', 100, 30)`,
      [order.id, product.id]
    );

    await receivePurchaseOrder(order.id, user.id, TODAY, main.id);

    assert.equal(await stockOf(product.id), 100);
    assert.equal(await heldAt(product.id, main.id), 100);
    await assertPlacementsMatchTotals(business.id, user.id, "after receiving");
  });

  test("selling takes the units off a location as well as off the total", async () => {
    await createSale({
      businessId: business.id, userId: user.id, customer: "Walk-in",
      payment: "cash", occurredOn: TODAY, locationId: main.id,
      lines: [{ productId: product.id, name: "Sugar", quantity: 10 }]
    });

    assert.equal(await stockOf(product.id), 90);
    assert.equal(await heldAt(product.id, main.id), 90);
    await assertPlacementsMatchTotals(business.id, user.id, "after selling");
  });

  test("voiding a sale puts them back where they came from", async () => {
    const sale = await one(
      "SELECT id FROM sales WHERE business_id = $1 ORDER BY id DESC LIMIT 1", [business.id]
    );
    await voidSale(sale.id, user.id);

    assert.equal(await stockOf(product.id), 100);
    assert.equal(await heldAt(product.id, main.id), 100);
    await assertPlacementsMatchTotals(business.id, user.id, "after voiding");
  });

  test("a sale that names no location comes off the default", async () => {
    await createSale({
      businessId: business.id, userId: user.id, customer: "Walk-in",
      payment: "cash", occurredOn: TODAY,
      lines: [{ productId: product.id, name: "Sugar", quantity: 5 }]
    });

    assert.equal(await heldAt(product.id, main.id), 95);
    await assertPlacementsMatchTotals(business.id, user.id, "after an unlocated sale");
  });
});

describe("moving stock between places", { skip: skipWithoutDb }, () => {
  let user;
  let business;
  let product;
  let main;
  let stall;

  before(async () => {
    user = await makeUser("wh-transfer");
    business = await makeBusiness(user.id, "Transfer Co");
    main = await ensureDefaultLocation(business.id, user.id);
    stall = await createLocation({
      businessId: business.id, userId: user.id, name: "Market stall"
    });
    product = await makeProduct(business.id, user.id, {
      name: "Sugar", quantity: 100, unitCost: 30, salePrice: 50, reorderPoint: 5
    });
    await placeUnplaced({ businessId: business.id, userId: user.id, locationId: main.id });
  });
  after(async () => { await dropUser(user?.id); });

  test("placing catches up stock that predates locations", async () => {
    assert.equal(await heldAt(product.id, main.id), 100);
    await assertPlacementsMatchTotals(business.id, user.id, "after placing");
  });

  test("and running it again places nothing", async () => {
    const { placed } = await placeUnplaced({ businessId: business.id, userId: user.id });
    assert.equal(placed, 0);
    assert.equal(await heldAt(product.id, main.id), 100);
  });

  test("a move changes where, never how much", async () => {
    const before = await stockOf(product.id);
    const out = await transferStock({
      businessId: business.id, userId: user.id, productId: product.id,
      fromId: main.id, toId: stall.id, quantity: 30, note: "stocking the stall", movedOn: TODAY
    });

    assert.equal(out.ok, true);
    assert.equal(await heldAt(product.id, main.id), 70);
    assert.equal(await heldAt(product.id, stall.id), 30);
    assert.equal(await stockOf(product.id), before, "the total is untouched");
    await assertPlacementsMatchTotals(business.id, user.id, "after moving");
  });

  test("moving more than is there is refused, and moves nothing", async () => {
    const out = await transferStock({
      businessId: business.id, userId: user.id, productId: product.id,
      fromId: stall.id, toId: main.id, quantity: 500, movedOn: TODAY
    });

    assert.equal(out.ok, false);
    assert.equal(out.available, 30);
    assert.equal(await heldAt(product.id, stall.id), 30, "nothing moved");
  });

  test("the move is recorded where somebody can read it", async () => {
    const [transfer] = await listTransfers(business.id, user.id);
    assert.equal(transfer.quantity, 30);
    assert.equal(transfer.from_name, "Main store");
    assert.equal(transfer.to_name, "Market stall");
    assert.equal(transfer.note, "stocking the stall");
  });

  test("and the report knows which location is empty", async () => {
    const report = await assertPlacementsMatchTotals(business.id, user.id, "report");
    const stallRow = report.perLocation.find((l) => l.name === "Market stall");
    assert.equal(stallRow.units, 30);
    assert.equal(stallRow.value, 30 * 30, "valued at cost");
  });
});

after(async () => { await closePool(); });
