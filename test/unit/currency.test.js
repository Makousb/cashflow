import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CURRENCIES, CURRENCY_BY_CODE, isSupportedCurrency } from "../../utils/currencies.js";
import { formatCurrency } from "../../utils/currency.js";

describe("formatCurrency", () => {
  test("a lettered symbol gets a space", () => {
    assert.equal(formatCurrency(1234.5, "KES"), "KSh 1,234.50");
  });

  test("a glyph hugs the number", () => {
    assert.equal(formatCurrency(1234.5, "USD"), "$1,234.50");
    assert.equal(formatCurrency(1234.5, "EUR"), "€1,234.50");
  });

  test("a glyph with letters in front still hugs", () => {
    assert.equal(formatCurrency(10, "CNY"), "CN¥10.00");
  });

  test("currencies without minor units show none", () => {
    assert.equal(formatCurrency(1234, "JPY"), "¥1,234");
    assert.equal(formatCurrency(1234, "UGX"), "USh 1,234");
  });

  test("groups thousands", () => {
    assert.equal(formatCurrency(1234567.89, "USD"), "$1,234,567.89");
  });

  test("handles zero and negatives", () => {
    assert.equal(formatCurrency(0, "KES"), "KSh 0.00");
    assert.equal(formatCurrency(-50, "USD"), "-$50.00");
  });

  test("non-numbers fall back to zero rather than NaN", () => {
    assert.equal(formatCurrency(undefined, "KES"), "KSh 0.00");
    assert.equal(formatCurrency("not a number", "KES"), "KSh 0.00");
  });

  test("numeric strings are accepted, as they arrive from the database", () => {
    assert.equal(formatCurrency("1234.50", "KES"), "KSh 1,234.50");
  });

  test("an unknown currency shows its code", () => {
    assert.equal(formatCurrency(10, "XYZ"), "XYZ 10.00");
  });

  test("defaults when no currency is given", () => {
    assert.equal(formatCurrency(10), "KSh 10.00");
  });
});

describe("the currency catalog", () => {
  test("every entry is complete", () => {
    for (const currency of CURRENCIES) {
      assert.ok(currency.code && currency.name && currency.symbol, currency.code);
      assert.ok(Number.isInteger(currency.decimals), currency.code);
    }
  });

  test("codes are unique", () => {
    assert.equal(new Set(CURRENCIES.map((c) => c.code)).size, CURRENCIES.length);
  });

  test("the lookup covers the list", () => {
    assert.equal(CURRENCY_BY_CODE.size, CURRENCIES.length);
    assert.equal(isSupportedCurrency("KES"), true);
    assert.equal(isSupportedCurrency("XYZ"), false);
  });
});
