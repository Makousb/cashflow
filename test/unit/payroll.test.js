import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { computePayslip } from "../../utils/payroll.js";

describe("computePayslip", () => {
  test("a salaried employee earns their rate", () => {
    const slip = computePayslip({ pay_type: "monthly", pay_rate: 32000, deduction_rate: 0 });
    assert.equal(slip.gross, 32000);
    assert.equal(slip.net, 32000);
  });

  test("hours do not change a salary", () => {
    const slip = computePayslip({
      pay_type: "monthly", pay_rate: 32000, hours: 200, deduction_rate: 0
    });
    assert.equal(slip.gross, 32000);
    assert.equal(slip.hours, 0);
  });

  test("an hourly employee earns rate times hours", () => {
    const slip = computePayslip({
      pay_type: "hourly", pay_rate: 320, hours: 48, deduction_rate: 0
    });
    assert.equal(slip.gross, 15360);
  });

  test("hours can be overridden for a one-off period", () => {
    const slip = computePayslip(
      { pay_type: "hourly", pay_rate: 320, hours: 48, deduction_rate: 0 }, 10
    );
    assert.equal(slip.gross, 3200);
    assert.equal(slip.hours, 10);
  });

  test("an override of zero hours is honoured, not ignored", () => {
    const slip = computePayslip(
      { pay_type: "hourly", pay_rate: 320, hours: 48, deduction_rate: 0 }, 0
    );
    assert.equal(slip.gross, 0);
  });

  test("deductions come off the gross", () => {
    const slip = computePayslip({
      pay_type: "monthly", pay_rate: 30000, deduction_rate: 12
    });
    assert.equal(slip.deductions, 3600);
    assert.equal(slip.net, 26400);
  });

  test("money is rounded to cents", () => {
    const slip = computePayslip({
      pay_type: "monthly", pay_rate: 1000, deduction_rate: 33.333
    });
    assert.equal(slip.deductions, 333.33);
    assert.equal(slip.net, 666.67);
  });

  test("gross always equals deductions plus net", () => {
    for (const rate of [0, 5, 12.5, 30, 100]) {
      const slip = computePayslip({
        pay_type: "monthly", pay_rate: 27350, deduction_rate: rate
      });
      assert.ok(Math.abs(slip.gross - (slip.deductions + slip.net)) < 0.01, `rate ${rate}`);
    }
  });

  test("missing figures come out as zero rather than NaN", () => {
    const slip = computePayslip({ pay_type: "hourly" });
    assert.equal(slip.gross, 0);
    assert.equal(slip.net, 0);
  });
});
