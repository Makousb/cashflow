import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { checkTransfer, placement, restockSuggestions, stockReport } from "../../utils/warehouse.js";

const product = (over = {}) => ({ id: 1, name: "Sugar", quantity: 100, unit_cost: 30, reorder_point: 0, ...over });
const at = (locationId, quantity, name = "Store", isDefault = false) => ({
  product_id: 1, location_id: locationId, quantity, location_name: name,
  location_code: null, is_default: isDefault
});

describe("where one product's stock sits", () => {
  test("adds the placements up and finds them agreeing with the total", () => {
    const out = placement(product({ quantity: 100 }), [at(1, 60), at(2, 40)]);
    assert.equal(out.total, 100);
    assert.equal(out.placed, 100);
    assert.equal(out.unplaced, 0);
    assert.equal(out.reconciled, true);
  });

  test("stock nobody has placed shows as the remainder, not as zero", () => {
    const out = placement(product({ quantity: 100 }), [at(1, 60)]);
    assert.equal(out.unplaced, 40);
    assert.equal(out.reconciled, false);
    assert.equal(out.overPlaced, false);
  });

  test("more placed than owned is called out rather than tidied away", () => {
    const out = placement(product({ quantity: 50 }), [at(1, 60)]);
    assert.equal(out.unplaced, -10);
    assert.equal(out.overPlaced, true);
  });

  test("a product placed nowhere is entirely unplaced", () => {
    const out = placement(product({ quantity: 100 }), []);
    assert.equal(out.placed, 0);
    assert.equal(out.unplaced, 100);
    assert.deepEqual(out.byLocation, []);
  });

  test("empty locations are left out, and the fullest comes first", () => {
    const out = placement(product({ quantity: 100 }), [at(1, 0), at(2, 30), at(3, 70)]);
    assert.equal(out.byLocation.length, 2);
    assert.equal(out.byLocation[0].quantity, 70);
  });
});

describe("the whole store", () => {
  const products = [product({ id: 1, quantity: 100, unit_cost: 30 }),
                    product({ id: 2, name: "Milk", quantity: 20, unit_cost: 50 })];
  const rows = [
    { ...at(1, 60, "Store", true) },
    { ...at(2, 40, "Stall") },
    { product_id: 2, location_id: 1, quantity: 20, location_name: "Store", is_default: true }
  ];
  const locations = [{ id: 1, name: "Store", is_default: true }, { id: 2, name: "Stall" }];
  const report = stockReport(products, rows, locations);

  test("values what is at each location at its cost", () => {
    const store = report.perLocation.find((l) => l.name === "Store");
    // 60 sugar at 30 + 20 milk at 50.
    assert.equal(store.value, 60 * 30 + 20 * 50);
    assert.equal(store.units, 80);
    assert.equal(store.lines, 2);
  });

  test("and reports whether everything is accounted for", () => {
    assert.equal(report.reconciled, true);
    assert.equal(report.unplacedCount, 0);
  });

  test("counting the products that are short of a home", () => {
    const short = stockReport(
      [product({ quantity: 100 })], [at(1, 60, "Store", true)], locations
    );
    assert.equal(short.unplacedCount, 1);
    assert.equal(short.reconciled, false);
  });
});

describe("moving stock", () => {
  test("is refused when there is not that much there", () => {
    const out = checkTransfer({ quantity: 50, available: 20, fromId: 1, toId: 2 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /only 20/);
  });

  test("rather than moving as much as it can", () => {
    // The point: a clamped move would report success for something that did
    // not happen the way the person asked.
    const out = checkTransfer({ quantity: 50, available: 20, fromId: 1, toId: 2 });
    assert.equal(out.amount, undefined);
  });

  test("refuses a move to the same place", () => {
    const out = checkTransfer({ quantity: 5, available: 20, fromId: 1, toId: 1 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /same place/);
  });

  test("refuses nothing, or a negative", () => {
    assert.equal(checkTransfer({ quantity: 0, available: 20, fromId: 1, toId: 2 }).ok, false);
    assert.equal(checkTransfer({ quantity: -5, available: 20, fromId: 1, toId: 2 }).ok, false);
  });

  test("and allows exactly what is there", () => {
    const out = checkTransfer({ quantity: 20, available: 20, fromId: 1, toId: 2 });
    assert.equal(out.ok, true);
    assert.equal(out.amount, 20);
  });
});

describe("what is worth moving", () => {
  const locations = [{ id: 1, name: "Store", is_default: true }, { id: 2, name: "Stall" }];

  test("names stock sitting somewhere it is not needed", () => {
    const report = stockReport(
      [product({ quantity: 100, reorder_point: 10 })],
      [at(1, 100, "Store", true)],
      locations
    );
    const out = restockSuggestions(report);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].empty, ["Stall"]);
    assert.equal(out[0].from.name, "Store");
  });

  test("says nothing when every location has some", () => {
    const report = stockReport(
      [product({ quantity: 100, reorder_point: 10 })],
      [at(1, 60, "Store", true), at(2, 40, "Stall")],
      locations
    );
    assert.deepEqual(restockSuggestions(report), []);
  });

  test("and nothing when there is no stock to move anywhere", () => {
    const report = stockReport(
      [product({ quantity: 0, reorder_point: 10 })], [], locations
    );
    assert.deepEqual(restockSuggestions(report), []);
  });

  test("a product with no reorder point is not something to chase", () => {
    const report = stockReport(
      [product({ quantity: 100, reorder_point: 0 })],
      [at(1, 100, "Store", true)],
      locations
    );
    assert.deepEqual(restockSuggestions(report), []);
  });
});
