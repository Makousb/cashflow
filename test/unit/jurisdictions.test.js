import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  JURISDICTIONS,
  addSalesTax,
  consolidate,
  extractSalesTax,
  isJurisdiction,
  ratesFor,
  salesTaxPosition
} from "../../utils/jurisdictions.js";

describe("where a business trades", () => {
  test("decides what the tax is called, not just its rate", () => {
    assert.equal(JURISDICTIONS.KE.salesTax.label, "VAT");
    assert.equal(JURISDICTIONS.IN.salesTax.label, "GST");
    assert.equal(JURISDICTIONS.US.salesTax.label, "Sales tax");
  });

  test("US sales tax is not reclaimable, unlike VAT", () => {
    assert.equal(JURISDICTIONS.US.salesTax.reclaimable, false);
    assert.equal(JURISDICTIONS.KE.salesTax.reclaimable, true);
  });

  test("and nonsense is not a jurisdiction", () => {
    assert.equal(isJurisdiction("ZZ"), false);
  });
});

describe("the rates a business actually uses", () => {
  test("its jurisdiction's, when it has said nothing", () => {
    const out = ratesFor({ jurisdiction: "GB", income_tax_rate: null, sales_tax_rate: null });
    assert.equal(out.incomeTax.rate, 25);
    assert.equal(out.salesTax.rate, 20);
    assert.equal(out.incomeTax.overridden, false);
  });

  test("its own, when it has", () => {
    const out = ratesFor({ jurisdiction: "GB", income_tax_rate: 19, sales_tax_rate: null });
    assert.equal(out.incomeTax.rate, 19);
    assert.equal(out.incomeTax.overridden, true);
  });

  test("zero is a real rate, not a missing one", () => {
    const out = ratesFor({ jurisdiction: "KE", income_tax_rate: null, sales_tax_rate: 0 });
    assert.equal(out.salesTax.rate, 0, "a zero-rated business is not a 16% one");
    assert.equal(out.salesTax.overridden, true);
  });

  test("an override that matches the default is not an override", () => {
    const out = ratesFor({ jurisdiction: "KE", income_tax_rate: 30, sales_tax_rate: null });
    assert.equal(out.incomeTax.overridden, false);
  });

  test("a business that has named nowhere still gets workable rates", () => {
    const out = ratesFor({});
    assert.equal(out.code, "KE");
    assert.ok(out.incomeTax.rate > 0);
  });
});

describe("adding and extracting sales tax", () => {
  test("adding it puts it on top", () => {
    assert.deepEqual(addSalesTax(1000, 16), { net: 1000, tax: 160, gross: 1160 });
  });

  test("extracting it from a tax-inclusive price is NOT the same sum", () => {
    const out = extractSalesTax(1160, 16);
    assert.equal(out.net, 1000);
    assert.equal(out.tax, 160);

    // The mistake this exists to prevent: 16% of the gross is 185.60, not 160.
    assert.notEqual(out.tax, 1160 * 0.16);
  });

  test("a zero rate leaves the price alone", () => {
    assert.deepEqual(extractSalesTax(1000, 0), { net: 1000, tax: 0, gross: 1000 });
  });

  test("the two are inverses", () => {
    const added = addSalesTax(2500, 18);
    assert.equal(extractSalesTax(added.gross, 18).net, 2500);
  });
});

describe("what is owed on consumption tax", () => {
  test("a VAT business hands over the difference", () => {
    const out = salesTaxPosition({ outputTax: 1600, inputTax: 600, reclaimable: true });
    assert.equal(out.net, 1000);
    assert.equal(out.owed, true);
  });

  test("and is owed a refund when it paid more than it charged", () => {
    const out = salesTaxPosition({ outputTax: 400, inputTax: 900, reclaimable: true });
    assert.equal(out.net, 500);
    assert.equal(out.refundDue, true);
    assert.equal(out.owed, false);
  });

  test("a sales-tax business owes all of what it collected", () => {
    const out = salesTaxPosition({ outputTax: 1600, inputTax: 600, reclaimable: false });
    assert.equal(out.net, 1600, "nothing is reclaimable");
    assert.equal(out.reclaimable, 0);
  });
});

describe("consolidating a group", () => {
  // Deliberately lopsided rates so converting-then-adding and
  // adding-then-converting cannot accidentally agree.
  const rateFor = (from, to) => {
    if (from === to) return 1;
    if (from === "UGX" && to === "KES") return 0.035;
    if (from === "NGN" && to === "KES") return 0.085;
    return 1;
  };

  const entities = [
    { business: { id: 1, name: "Parent" }, currency: "KES",
      figures: { revenue: 500000, expenses: 300000, netProfit: 200000, assets: 800000, liabilities: 100000 } },
    { business: { id: 2, name: "Kampala" }, currency: "UGX",
      figures: { revenue: 20000000, expenses: 14000000, netProfit: 6000000, assets: 30000000, liabilities: 5000000 } },
    { business: { id: 3, name: "Lagos" }, currency: "NGN",
      figures: { revenue: 4000000, expenses: 3000000, netProfit: 1000000, assets: 6000000, liabilities: 2000000 } }
  ];

  const out = consolidate({ entities, currency: "KES", rateFor });

  test("converts each entity before adding anything up", () => {
    // 500,000 + (20,000,000 × 0.035) + (4,000,000 × 0.085)
    assert.equal(out.totals.revenue, 500000 + 700000 + 340000);
  });

  test("keeps each branch's own figures in its own money", () => {
    const kampala = out.rows.find((r) => r.business.name === "Kampala");
    assert.equal(kampala.own.revenue, 20000000, "still shillings");
    assert.equal(kampala.converted.revenue, 700000);
    assert.equal(kampala.rate, 0.035);
  });

  test("equity falls out of the converted totals", () => {
    const assets = 800000 + 30000000 * 0.035 + 6000000 * 0.085;
    const liabilities = 100000 + 5000000 * 0.035 + 2000000 * 0.085;
    assert.equal(out.totals.equity, Math.round((assets - liabilities) * 100) / 100);
  });

  test("says when a group spans more than one currency", () => {
    assert.equal(out.multiCurrency, true);
    assert.equal(out.entityCount, 3);
  });

  test("and does not make a single-currency group look like an FX problem", () => {
    const same = consolidate({
      entities: [entities[0]], currency: "KES", rateFor
    });
    assert.equal(same.multiCurrency, false);
    assert.equal(same.rows[0].rate, 1);
  });

  test("an empty group totals to nothing rather than failing", () => {
    const none = consolidate({ entities: [], currency: "KES", rateFor });
    assert.equal(none.totals.revenue, 0);
    assert.equal(none.entityCount, 0);
  });
});
