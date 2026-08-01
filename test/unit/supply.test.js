import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  addDays,
  daysBetween,
  deliveredOnTime,
  estimateEta,
  isLate,
  lateness,
  monthlySeries,
  partnerScorecards,
  progressPercent,
  statusMeta,
  summarizeOrders,
  targetDate,
  timeline,
  topItems,
  transitDays
} from "../../utils/supply.js";

describe("dates", () => {
  test("adds days across a month boundary", () => {
    assert.equal(addDays("2026-01-30", 3), "2026-02-02");
  });

  test("adds days across a year boundary", () => {
    assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  });

  test("counts whole days between two dates", () => {
    assert.equal(daysBetween("2026-03-01", "2026-03-08"), 7);
  });

  test("goes negative when the second date is earlier", () => {
    assert.equal(daysBetween("2026-03-08", "2026-03-01"), -7);
  });

  test("returns null when a date is missing", () => {
    assert.equal(daysBetween(null, "2026-03-01"), null);
  });
});

describe("estimateEta", () => {
  test("uses the stated lead time with no history", () => {
    const eta = estimateEta({ leadTimeDays: 3, samples: [], from: "2026-05-01" });
    assert.equal(eta.days, 3);
    assert.equal(eta.date, "2026-05-04");
    assert.match(eta.basis, /stated lead time/);
  });

  test("blends the lead time with one past delivery", () => {
    const eta = estimateEta({ leadTimeDays: 3, samples: [5], from: "2026-05-01" });
    assert.equal(eta.days, 4);
    assert.match(eta.basis, /1 past delivery/);
  });

  test("trusts the median once there is real history", () => {
    // What a supplier actually does beats what they claim.
    const eta = estimateEta({ leadTimeDays: 2, samples: [6, 7, 6, 8], from: "2026-05-01" });
    assert.equal(eta.days, 7);
    assert.match(eta.basis, /median of the last 4 deliveries/);
  });

  test("never promises same-day", () => {
    const eta = estimateEta({ leadTimeDays: 0, samples: [0, 0, 0], from: "2026-05-01" });
    assert.equal(eta.days, 1);
  });

  test("ignores nonsense samples", () => {
    const eta = estimateEta({
      leadTimeDays: 3, samples: [null, undefined, NaN, -4], from: "2026-05-01"
    });
    assert.equal(eta.days, 3);
    assert.equal(eta.samples, 0);
  });
});

describe("a single order", () => {
  const shipped = {
    status: "shipped",
    placed_on: "2026-04-01",
    promised_on: "2026-04-05",
    expected_on: "2026-04-04"
  };

  test("the supplier's commitment beats the estimate", () => {
    assert.equal(targetDate(shipped), "2026-04-05");
    assert.equal(targetDate({ ...shipped, promised_on: null }), "2026-04-04");
  });

  test("an open order past its date is late", () => {
    assert.equal(isLate(shipped, "2026-04-09"), true);
    assert.equal(lateness(shipped, "2026-04-09"), 4);
  });

  test("an open order still within its date is not", () => {
    assert.equal(isLate(shipped, "2026-04-03"), false);
  });

  test("a finished order is judged on when it arrived, not today", () => {
    const delivered = { ...shipped, status: "delivered", delivered_at: "2026-04-04" };
    assert.equal(isLate(delivered, "2026-06-01"), false);
    assert.equal(deliveredOnTime(delivered), true);
  });

  test("arriving after the promised date is not on time", () => {
    const late = { ...shipped, status: "delivered", delivered_at: "2026-04-08" };
    assert.equal(deliveredOnTime(late), false);
    assert.equal(lateness(late), 3);
  });

  test("measures how long it actually took", () => {
    assert.equal(transitDays({ ...shipped, delivered_at: "2026-04-06" }), 5);
    assert.equal(transitDays(shipped), null);
  });

  test("the trail marks every stage reached", () => {
    const steps = timeline({ ...shipped, confirmed_at: "2026-04-02" });
    const done = steps.filter((s) => s.done).map((s) => s.status);
    assert.deepEqual(done, ["placed", "confirmed", "shipped"]);
    assert.equal(steps.find((s) => s.current).status, "shipped");
  });

  test("progress advances with the status", () => {
    assert.equal(progressPercent({ status: "placed" }), 20);
    assert.equal(progressPercent({ status: "received" }), 100);
    assert.equal(progressPercent({ status: "cancelled" }), 100);
  });

  test("every status has something to show", () => {
    for (const status of ["placed", "confirmed", "shipped", "delivered",
                          "received", "cancelled", "declined"]) {
      const meta = statusMeta(status);
      assert.ok(meta.label && meta.icon && meta.badge, status);
    }
  });
});

describe("summarizeOrders", () => {
  const orders = [
    { status: "placed", total: 100, placed_on: "2026-04-01", promised_on: "2026-04-03" },
    { status: "shipped", total: 200, placed_on: "2026-04-02", promised_on: "2026-04-04" },
    { status: "received", total: 300, placed_on: "2026-03-01",
      promised_on: "2026-03-05", delivered_at: "2026-03-04" },
    { status: "delivered", total: 400, placed_on: "2026-03-10",
      promised_on: "2026-03-12", delivered_at: "2026-03-15" },
    { status: "cancelled", total: 999, placed_on: "2026-03-20" }
  ];

  test("counts what is still moving", () => {
    const summary = summarizeOrders(orders, "2026-04-10");
    assert.equal(summary.openCount, 3);
    assert.equal(summary.openValue, 700);
    assert.equal(summary.inTransitCount, 2);
  });

  test("leaves cancelled value out of the total", () => {
    assert.equal(summarizeOrders(orders, "2026-04-10").totalValue, 1000);
  });

  test("scores on-time against the promised date", () => {
    // Of two arrivals, one beat its date and one missed.
    assert.equal(summarizeOrders(orders, "2026-04-10").onTimeRate, 50);
  });

  test("fulfilment counts arrivals against write-offs", () => {
    const summary = summarizeOrders(orders, "2026-04-10");
    assert.ok(Math.abs(summary.fulfillmentRate - 66.67) < 0.01);
  });

  test("averages how long deliveries really take", () => {
    assert.equal(summarizeOrders(orders, "2026-04-10").avgTransitDays, 4);
  });

  test("flags open orders that have run past their date", () => {
    assert.equal(summarizeOrders(orders, "2026-04-10").lateCount, 2);
    assert.equal(summarizeOrders(orders, "2026-04-01").lateCount, 0);
  });

  test("has no opinion without deliveries", () => {
    const summary = summarizeOrders([{ status: "placed", total: 10, placed_on: "2026-04-01" }]);
    assert.equal(summary.onTimeRate, null);
    assert.equal(summary.avgTransitDays, null);
  });

  test("survives an empty list", () => {
    const summary = summarizeOrders([]);
    assert.equal(summary.count, 0);
    assert.equal(summary.totalValue, 0);
  });
});

describe("partnerScorecards", () => {
  const orders = [
    { supplier_business_id: 1, supplier_name: "Kicheko", status: "received",
      total: 500, placed_on: "2026-03-01" },
    { supplier_business_id: 1, supplier_name: "Kicheko", status: "received",
      total: 300, placed_on: "2026-03-05" },
    { supplier_business_id: 2, supplier_name: "Mwangi", status: "received",
      total: 900, placed_on: "2026-03-02" }
  ];

  test("groups by counterpart and ranks by value", () => {
    const cards = partnerScorecards(orders, "supplier");
    assert.deepEqual(cards.map((c) => c.name), ["Mwangi", "Kicheko"]);
    assert.equal(cards[1].count, 2);
    assert.equal(cards[1].totalValue, 800);
  });

  test("can look at the trade from the selling side", () => {
    const cards = partnerScorecards(
      [{ buyer_business_id: 7, buyer_name: "Mama Njeri", status: "received",
         total: 100, placed_on: "2026-03-01" }],
      "buyer"
    );
    assert.equal(cards[0].name, "Mama Njeri");
  });
});

describe("reporting helpers", () => {
  test("monthly series keeps a slot for quiet months", () => {
    const series = monthlySeries([], 6);
    assert.equal(series.length, 6);
    assert.ok(series.every((m) => m.count === 0 && m.value === 0));
  });

  test("top items rank by what they cost you", () => {
    const items = topItems([
      { name: "Sugar 2kg", quantity: 10, unit_price: 200 },
      { name: "sugar 2kg", quantity: 5, unit_price: 200 },
      { name: "Bread", quantity: 40, unit_price: 50 }
    ]);
    assert.equal(items[0].name, "Sugar 2kg");
    assert.equal(items[0].quantity, 15, "same item under different casing is one row");
    assert.equal(items[0].value, 3000);
    assert.equal(items[1].name, "Bread");
  });
});
