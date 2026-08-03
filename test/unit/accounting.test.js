import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { reviewLedger, taxPosition } from "../../utils/accounting.js";

const codes = (r) => r.findings.map((f) => f.code);
const find = (r, code) => r.findings.find((f) => f.code === code);

describe("taxPosition", () => {
  test("taxes the accrual profit, not the cash net", () => {
    const t = taxPosition({ accrualProfit: 100000, rate: 30 });
    assert.equal(t.taxableProfit, 100000);
    assert.equal(t.incomeTax, 30000);
  });

  test("a loss is not taxed", () => {
    const t = taxPosition({ accrualProfit: -50000, rate: 30 });
    assert.equal(t.taxableProfit, 0);
    assert.equal(t.incomeTax, 0);
    assert.equal(t.totalOwed, 0);
  });

  test("payroll deductions are owed on top of income tax", () => {
    const t = taxPosition({ accrualProfit: 100000, rate: 30, payrollDeductions: 8000 });
    assert.equal(t.totalOwed, 38000);
  });

  test("payroll deductions are owed even at a loss", () => {
    // They are the staff's money, withheld — not a share of profit.
    const t = taxPosition({ accrualProfit: -1000, rate: 30, payrollDeductions: 8000 });
    assert.equal(t.totalOwed, 8000);
  });

  test("what is set aside reduces the shortfall", () => {
    const t = taxPosition({ accrualProfit: 100000, rate: 30, setAside: 10000 });
    assert.equal(t.shortfall, 20000);
    assert.ok(Math.abs(t.coverage - 33.33) < 0.01);
  });

  test("over-providing is a surplus, never a negative shortfall", () => {
    const t = taxPosition({ accrualProfit: 10000, rate: 10, setAside: 5000 });
    assert.equal(t.shortfall, 0);
    assert.equal(t.surplus, 4000);
    assert.equal(t.coverage, 100);
  });

  test("owing nothing counts as fully covered", () => {
    const t = taxPosition({ accrualProfit: 0, rate: 30 });
    assert.equal(t.coverage, 100);
    assert.equal(t.shortfall, 0);
  });

  test("missing figures do not produce NaN", () => {
    const t = taxPosition({});
    for (const [k, v] of Object.entries(t)) {
      assert.ok(Number.isFinite(v), `${k} was ${v}`);
    }
  });
});

describe("reviewLedger — entries with no real category", () => {
  test("catches blanks, Uncategorized and Other alike", () => {
    const r = reviewLedger({
      transactions: [
        { id: 1, kind: "expense", amount: 100, category: "Other", occurred_on: "2026-05-01" },
        { id: 2, kind: "expense", amount: 200, category: "", occurred_on: "2026-05-02" },
        { id: 3, kind: "expense", amount: 300, category: null, occurred_on: "2026-05-03" },
        { id: 4, kind: "expense", amount: 400, category: "Rent", occurred_on: "2026-05-04" }
      ],
      today: "2026-05-10"
    });
    const f = find(r, "uncategorised");
    assert.ok(f);
    assert.deepEqual(f.subjects, [1, 2, 3]);
    assert.equal(f.amount, 600);
    assert.equal(f.severity, "high");
  });

  test("says nothing when every entry is filed", () => {
    const r = reviewLedger({
      transactions: [{ id: 1, kind: "expense", amount: 100, category: "Rent", occurred_on: "2026-05-01" }],
      today: "2026-05-10"
    });
    assert.ok(!codes(r).includes("uncategorised"));
  });
});

describe("reviewLedger — duplicates", () => {
  const pair = (d1, d2, amount = 12000) => ([
    { id: 1, kind: "expense", amount, category: "Rent", occurred_on: d1 },
    { id: 2, kind: "expense", amount, category: "Rent", occurred_on: d2 }
  ]);

  test("flags the same amount and category a day apart", () => {
    const r = reviewLedger({ transactions: pair("2026-05-01", "2026-05-02"), today: "2026-05-10" });
    const f = find(r, "duplicate");
    assert.ok(f);
    assert.deepEqual(f.subjects, [1, 2]);
  });

  test("ignores the same amount weeks apart — that is just rent", () => {
    const r = reviewLedger({ transactions: pair("2026-05-01", "2026-06-01"), today: "2026-06-10" });
    assert.ok(!codes(r).includes("duplicate"));
  });

  test("ignores small repeated amounts", () => {
    const r = reviewLedger({ transactions: pair("2026-05-01", "2026-05-02", 50), today: "2026-05-10" });
    assert.ok(!codes(r).includes("duplicate"));
  });

  test("ignores matching amounts in different categories", () => {
    const r = reviewLedger({
      transactions: [
        { id: 1, kind: "expense", amount: 9000, category: "Rent", occurred_on: "2026-05-01" },
        { id: 2, kind: "expense", amount: 9000, category: "Payroll", occurred_on: "2026-05-01" }
      ],
      today: "2026-05-10"
    });
    assert.ok(!codes(r).includes("duplicate"));
  });

  test("works on the Date objects the database actually returns", () => {
    // Stringifying a Date gives "Sun Jun 28 2026…", which sorts by weekday name.
    // With ISO strings this passed while the real books threw false positives.
    const r = reviewLedger({
      transactions: [
        { id: 1, kind: "expense", amount: 45000, category: "Payroll",
          occurred_on: new Date(2026, 4, 28) },
        { id: 2, kind: "expense", amount: 45000, category: "Payroll",
          occurred_on: new Date(2026, 5, 28) }
      ],
      today: "2026-07-01"
    });
    assert.ok(!codes(r).includes("duplicate"), "a month apart is not a duplicate");
  });

  test("still catches a real duplicate given Date objects", () => {
    const r = reviewLedger({
      transactions: [
        { id: 1, kind: "expense", amount: 45000, category: "Payroll",
          occurred_on: new Date(2026, 4, 28) },
        { id: 2, kind: "expense", amount: 45000, category: "Payroll",
          occurred_on: new Date(2026, 4, 29) }
      ],
      today: "2026-07-01"
    });
    assert.ok(codes(r).includes("duplicate"));
  });

  test("a run of identical entries is one finding, not every pairing", () => {
    // Four entries would be six pairs, which buries everything else.
    const r = reviewLedger({
      transactions: [1, 2, 3, 4].map((id) => ({
        id, kind: "income", amount: 2600, category: "Sales", occurred_on: "2026-05-01"
      })),
      today: "2026-05-10"
    });
    const dupes = r.findings.filter((f) => f.code === "duplicate");
    assert.equal(dupes.length, 1);
    assert.deepEqual(dupes[0].subjects, [1, 2, 3, 4]);
    assert.match(dupes[0].title, /4 identical Sales entries/);
    assert.equal(dupes[0].amount, 7800, "three of the four are the overstatement");
  });

  test("separate runs of the same amount are separate findings", () => {
    const r = reviewLedger({
      transactions: [
        { id: 1, kind: "expense", amount: 9000, category: "Rent", occurred_on: "2026-05-01" },
        { id: 2, kind: "expense", amount: 9000, category: "Rent", occurred_on: "2026-05-02" },
        { id: 3, kind: "expense", amount: 9000, category: "Rent", occurred_on: "2026-08-01" },
        { id: 4, kind: "expense", amount: 9000, category: "Rent", occurred_on: "2026-08-02" }
      ],
      today: "2026-08-10"
    });
    assert.equal(r.findings.filter((f) => f.code === "duplicate").length, 2);
  });

  test("order does not matter", () => {
    const rows = [
      { id: 1, kind: "expense", amount: 9000, category: "Rent", occurred_on: "2026-05-02" },
      { id: 2, kind: "expense", amount: 9000, category: "Rent", occurred_on: "2026-05-01" }
    ];
    assert.equal(codes(reviewLedger({ transactions: rows, today: "2026-05-10" })).includes("duplicate"), true);
    assert.equal(codes(reviewLedger({ transactions: [...rows].reverse(), today: "2026-05-10" })).includes("duplicate"), true);
  });

  test("does not pair income against expense", () => {
    const r = reviewLedger({
      transactions: [
        { id: 1, kind: "income", amount: 9000, category: "Sales", occurred_on: "2026-05-01" },
        { id: 2, kind: "expense", amount: 9000, category: "Sales", occurred_on: "2026-05-01" }
      ],
      today: "2026-05-10"
    });
    assert.ok(!codes(r).includes("duplicate"));
  });
});

describe("reviewLedger — money owed both ways", () => {
  const invoice = (over) => ({ id: 7, status: "unpaid", amount: 5000, due_on: "2026-05-01",
    customer: "Kariuki Hotel", ...over });

  test("an overdue invoice is raised", () => {
    const r = reviewLedger({ invoices: [invoice()], today: "2026-05-11" });
    const f = find(r, "overdue-receivable");
    assert.ok(f);
    assert.match(f.title, /10 days late/);
    assert.equal(f.severity, "medium");
  });

  test("more than a month late is escalated", () => {
    const r = reviewLedger({ invoices: [invoice()], today: "2026-06-15" });
    assert.equal(find(r, "overdue-receivable").severity, "high");
  });

  test("a paid invoice is not chased", () => {
    const r = reviewLedger({ invoices: [invoice({ status: "paid" })], today: "2026-06-15" });
    assert.ok(!codes(r).includes("overdue-receivable"));
  });

  test("an invoice not yet due is not chased", () => {
    const r = reviewLedger({ invoices: [invoice()], today: "2026-04-20" });
    assert.ok(!codes(r).includes("overdue-receivable"));
  });

  test("overdue bills are raised separately", () => {
    const r = reviewLedger({
      bills: [{ id: 3, status: "unpaid", amount: 4100, due_on: "2026-05-01", vendor: "Kenya Power" }],
      today: "2026-05-11"
    });
    assert.ok(find(r, "overdue-payable"));
  });
});

describe("reviewLedger — trading", () => {
  test("stock priced below cost is a high finding", () => {
    const r = reviewLedger({
      products: [{ id: 1, name: "Rice 5kg", unit_cost: 780, sale_price: 700 }],
      today: "2026-05-01"
    });
    const f = find(r, "priced-at-cost");
    assert.equal(f.severity, "high");
  });

  test("stock priced exactly at cost is flagged more gently", () => {
    const r = reviewLedger({
      products: [{ id: 1, name: "Rice 5kg", unit_cost: 780, sale_price: 780 }],
      today: "2026-05-01"
    });
    assert.equal(find(r, "priced-at-cost").severity, "medium");
  });

  test("a healthy margin is left alone", () => {
    const r = reviewLedger({
      products: [{ id: 1, name: "Sugar", unit_cost: 200, sale_price: 260 }],
      today: "2026-05-01"
    });
    assert.ok(!codes(r).includes("priced-at-cost"));
  });

  test("sales that cost more than they earned are totalled", () => {
    const r = reviewLedger({
      sales: [
        { id: 1, total: 100, cost_total: 150 },
        { id: 2, total: 200, cost_total: 260 },
        { id: 3, total: 500, cost_total: 300 }
      ],
      today: "2026-05-01"
    });
    const f = find(r, "sold-at-a-loss");
    assert.deepEqual(f.subjects, [1, 2]);
    assert.equal(f.amount, 110);
  });

  test("a month with nothing in it is a bookkeeping gap", () => {
    const r = reviewLedger({
      trend: [
        { month: "2026-03", revenue: 1000, expenses: 400 },
        { month: "2026-04", revenue: 0, expenses: 0 },
        { month: "2026-05", revenue: 900, expenses: 300 }
      ],
      today: "2026-05-20"
    });
    const f = find(r, "quiet-month");
    assert.ok(f);
    assert.match(f.title, /2026-04/);
  });
});

describe("reviewLedger — spending spikes", () => {
  const history = (amounts, category = "Transport") =>
    amounts.map(([month, amount], i) => ({
      id: i + 1, kind: "expense", amount, category, occurred_on: `${month}-15`
    }));

  test("raises a category well above its own average", () => {
    const r = reviewLedger({
      transactions: history([
        ["2026-03", 6000], ["2026-04", 6000], ["2026-05", 30000]
      ]),
      today: "2026-05-20"
    });
    const f = find(r, "spike");
    assert.ok(f);
    assert.match(f.title, /5\.0×/);
  });

  test("stays quiet on a normal month", () => {
    const r = reviewLedger({
      transactions: history([["2026-03", 6000], ["2026-04", 6000], ["2026-05", 6500]]),
      today: "2026-05-20"
    });
    assert.ok(!codes(r).includes("spike"));
  });

  test("needs history before it will call anything unusual", () => {
    const r = reviewLedger({
      transactions: history([["2026-04", 6000], ["2026-05", 30000]]),
      today: "2026-05-20"
    });
    assert.ok(!codes(r).includes("spike"));
  });

  test("ignores small categories doubling", () => {
    const r = reviewLedger({
      transactions: history([["2026-03", 100], ["2026-04", 100], ["2026-05", 900]]),
      today: "2026-05-20"
    });
    assert.ok(!codes(r).includes("spike"));
  });
});

describe("reviewLedger — tax", () => {
  test("an uncovered tax bill is raised", () => {
    const tax = taxPosition({ accrualProfit: 100000, rate: 30, setAside: 10000 });
    const r = reviewLedger({ tax, today: "2026-05-01" });
    const f = find(r, "tax-shortfall");
    assert.ok(f);
    assert.equal(f.amount, 20000);
    assert.equal(f.action, "set-aside");
    assert.equal(f.severity, "high", "a third covered is serious");
  });

  test("a mostly covered bill is gentler", () => {
    const tax = taxPosition({ accrualProfit: 100000, rate: 30, setAside: 25000 });
    assert.equal(find(reviewLedger({ tax, today: "2026-05-01" }), "tax-shortfall").severity, "medium");
  });

  test("a covered bill is not raised at all", () => {
    const tax = taxPosition({ accrualProfit: 100000, rate: 30, setAside: 30000 });
    assert.ok(!codes(reviewLedger({ tax, today: "2026-05-01" })).includes("tax-shortfall"));
  });

  test("stock with no purchase behind it is called out as overstating profit", () => {
    const tax = taxPosition({ accrualProfit: 1000, rate: 30, setAside: 1000 });
    const r = reviewLedger({
      tax, stock: { unpurchasedStock: true, closingInventory: 5000, purchases: 0 },
      today: "2026-05-01"
    });
    assert.ok(find(r, "unpurchased-stock"));
  });
});

describe("reviewLedger — the report itself", () => {
  test("clean books produce no findings", () => {
    const r = reviewLedger({ today: "2026-05-01" });
    assert.equal(r.clean, true);
    assert.equal(r.counts.total, 0);
  });

  test("counts by severity", () => {
    const r = reviewLedger({
      transactions: [{ id: 1, kind: "expense", amount: 100, category: "Other", occurred_on: "2026-05-01" }],
      products: [{ id: 1, name: "X", unit_cost: 100, sale_price: 100 }],
      today: "2026-05-10"
    });
    assert.equal(r.counts.high, 1);
    assert.equal(r.counts.medium, 1);
    assert.equal(r.counts.total, 2);
    assert.equal(r.clean, false);
  });

  test("the worst thing is listed first", () => {
    const r = reviewLedger({
      products: [{ id: 1, name: "X", unit_cost: 100, sale_price: 100 }],
      transactions: [{ id: 1, kind: "expense", amount: 100, category: "Other", occurred_on: "2026-05-01" }],
      today: "2026-05-10"
    });
    assert.equal(r.findings[0].severity, "high");
  });

  test("every finding is renderable", () => {
    const r = reviewLedger({
      transactions: [{ id: 1, kind: "expense", amount: 100, category: "Other", occurred_on: "2026-05-01" }],
      invoices: [{ id: 2, status: "unpaid", amount: 5000, due_on: "2026-04-01", customer: "A" }],
      products: [{ id: 3, name: "X", unit_cost: 100, sale_price: 90 }],
      sales: [{ id: 4, total: 10, cost_total: 20 }],
      tax: taxPosition({ accrualProfit: 100000, rate: 30 }),
      today: "2026-05-10"
    });
    assert.ok(r.findings.length >= 5);
    for (const f of r.findings) {
      assert.ok(f.code && f.title && f.detail, JSON.stringify(f));
      assert.ok(["high", "medium", "low"].includes(f.severity), f.severity);
    }
  });
});
