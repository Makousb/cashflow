import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isEmailShaped } from "../../utils/validation.js";

describe("isEmailShaped", () => {
  test("accepts ordinary addresses", () => {
    assert.equal(isEmailShaped("amina@example.com"), true);
    assert.equal(isEmailShaped("a.b+tag@sub.example.co.ke"), true);
  });

  test("refuses what a browser's type=\"email\" also would", () => {
    assert.equal(isEmailShaped("not-an-email-at-all"), false);
    assert.equal(isEmailShaped("missing-domain@"), false);
    assert.equal(isEmailShaped("@missing-local.com"), false);
    assert.equal(isEmailShaped("no-at-sign.example.com"), false);
    assert.equal(isEmailShaped("has spaces@example.com"), false);
    assert.equal(isEmailShaped("no-dot@examplecom"), false);
  });

  test("refuses empty, missing, and non-string values", () => {
    assert.equal(isEmailShaped(""), false);
    assert.equal(isEmailShaped(undefined), false);
    assert.equal(isEmailShaped(null), false);
  });
});
