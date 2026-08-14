import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  attachPayRunTransaction,
  claimPayRun,
  createEmployee,
  deletePayRun,
  listPayRuns,
  listPayslips,
  releasePayRun
} from "../../db/queries/payroll.js";
import { adjustProductStock } from "../../db/queries/inventory.js";
import {
  closePool, dropUser, makeBusiness, makeProduct, makeUser, one, q, skipWithoutDb, stockOf
} from "./helpers.js";

const PERIOD = "August 2026";

const slipsFor = (employeeId) => [
  { employeeId, name: "Sam", gross: 30000, deductions: 3000, net: 27000 }
];

// Paying the same month twice is not a duplicate row: it is twice the wages on
// the income statement and twice the deductions on the tax position. Two
// clicks used to do it.
describe("running a pay period", { skip: skipWithoutDb }, () => {
  let user;
  let business;
  let employee;

  before(async () => {
    user = await makeUser("payroll-claim");
    business = await makeBusiness(user.id, "Pay Shop");
    employee = await createEmployee({
      businessId: business.id, userId: user.id, name: "Sam", role: "Clerk",
      payType: "monthly", payRate: 30000, hours: 0, deductionRate: 10
    });
  });

  after(async () => {
    await dropUser(user?.id);
  });

  test("claims the period and writes the payslips", async () => {
    const run = await claimPayRun({
      businessId: business.id, userId: user.id, period: PERIOD,
      runOn: "2026-08-31", payslips: slipsFor(employee.id)
    });

    assert.ok(run, "the first run must get the period");
    assert.equal(Number(run.gross_total), 30000);
    assert.equal(Number(run.deduction_total), 3000);
    assert.equal(Number(run.net_total), 27000);
    assert.equal(run.employee_count, 1);
    assert.equal((await listPayslips(run.id)).length, 1);
  });

  test("and refuses the same period a second time", async () => {
    const again = await claimPayRun({
      businessId: business.id, userId: user.id, period: PERIOD,
      runOn: "2026-08-31", payslips: slipsFor(employee.id)
    });

    assert.equal(again, null, "the second claim must come back empty");
    const runs = await listPayRuns(business.id, user.id);
    assert.equal(runs.length, 1, "one period, one run");
  });

  test("leaving no half-written payslips behind when it refuses", async () => {
    const slips = await q(
      `SELECT p.id FROM payslips p
       JOIN pay_runs r ON r.id = p.pay_run_id
       WHERE r.business_id = $1`,
      [business.id]
    );
    assert.equal(slips.length, 1);
  });

  test("five at once still yield exactly one run", async () => {
    const period = "September 2026";
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => claimPayRun({
        businessId: business.id, userId: user.id, period,
        runOn: "2026-09-30", payslips: slipsFor(employee.id)
      }))
    );

    const won = claims.filter(Boolean);
    assert.equal(won.length, 1, "exactly one of five simultaneous claims may land");
    const runs = await q(
      "SELECT id FROM pay_runs WHERE business_id = $1 AND period = $2",
      [business.id, period]
    );
    assert.equal(runs.length, 1);
  });

  test("a released claim frees the period again", async () => {
    const period = "October 2026";
    const first = await claimPayRun({
      businessId: business.id, userId: user.id, period,
      runOn: "2026-10-31", payslips: slipsFor(employee.id)
    });
    // What happens when the posting after the claim throws: the period was
    // never actually paid, so it must not stay blocked.
    await releasePayRun(first.id);

    const second = await claimPayRun({
      businessId: business.id, userId: user.id, period,
      runOn: "2026-10-31", payslips: slipsFor(employee.id)
    });
    assert.ok(second, "the period is free once the failed claim is given back");
  });

  test("and deleting a run lets that month be paid again", async () => {
    const run = await claimPayRun({
      businessId: business.id, userId: user.id, period: "November 2026",
      runOn: "2026-11-30", payslips: slipsFor(employee.id)
    });
    await attachPayRunTransaction(run.id, null);
    await deletePayRun(run.id, user.id);

    const redo = await claimPayRun({
      businessId: business.id, userId: user.id, period: "November 2026",
      runOn: "2026-11-30", payslips: slipsFor(employee.id)
    });
    assert.ok(redo, "a deleted run releases its period");
  });
});

// A count is the one number an inventory has to be honest about — a sale asks
// it whether it can sell.
describe("adjusting stock by hand", { skip: skipWithoutDb }, () => {
  let user;
  let business;
  let product;

  before(async () => {
    user = await makeUser("stock-adjust");
    business = await makeBusiness(user.id, "Count Shop");
    product = await makeProduct(business.id, user.id, {
      name: "Rice 5kg", quantity: 50, unitCost: 500, salePrice: 700
    });
  });

  after(async () => {
    await dropUser(user?.id);
  });

  test("adds what it is given", async () => {
    const result = await adjustProductStock(product.id, user.id, 10);
    assert.equal(Number(result.product.quantity), 60);
  });

  test("takes off what is there", async () => {
    const result = await adjustProductStock(product.id, user.id, -20);
    assert.equal(Number(result.product.quantity), 40);
  });

  test("and refuses to take off more than is there", async () => {
    // It used to clamp to zero and report success, so asking to remove 9,999
    // from a shelf holding 40 emptied the shelf and said "Stock updated."
    const result = await adjustProductStock(product.id, user.id, -9999);

    assert.equal(result.product, undefined, "nothing may have moved");
    assert.equal(result.available, 40, "it says what is actually there");
    assert.equal(await stockOf(product.id), 40, "the shelf is untouched");
  });

  test("down to exactly zero is fine", async () => {
    const result = await adjustProductStock(product.id, user.id, -40);
    assert.equal(Number(result.product.quantity), 0);
  });

  test("and a product that is not yours is not found", async () => {
    const stranger = await makeUser("stock-stranger");
    try {
      const result = await adjustProductStock(product.id, stranger.id, 5);
      assert.equal(result.missing, true);
      assert.equal(await stockOf(product.id), 0);
    } finally {
      await dropUser(stranger.id);
    }
  });

  after(closePool);
});
