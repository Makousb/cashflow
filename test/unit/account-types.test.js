import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ACCOUNT_TYPES, homeFor, isAccountType } from "../../utils/account-types.js";

describe("the three sides", () => {
  test("there are exactly three", () => {
    assert.deepEqual(Object.keys(ACCOUNT_TYPES), ["personal", "business", "supplier"]);
  });

  test("each one is complete", () => {
    for (const [key, side] of Object.entries(ACCOUNT_TYPES)) {
      assert.ok(side.label, key);
      assert.ok(side.blurb, key);
      assert.ok(side.icon, key);
      assert.match(side.home, /^\//, key);
    }
  });

  test("each lands somewhere different", () => {
    const homes = Object.values(ACCOUNT_TYPES).map((s) => s.home);
    assert.equal(new Set(homes).size, homes.length);
  });
});

describe("isAccountType", () => {
  test("accepts the real ones", () => {
    assert.equal(isAccountType("personal"), true);
    assert.equal(isAccountType("business"), true);
    assert.equal(isAccountType("supplier"), true);
  });

  test("rejects anything else", () => {
    assert.equal(isAccountType("admin"), false);
    assert.equal(isAccountType(""), false);
    assert.equal(isAccountType(undefined), false);
  });

  test("inherited properties are not account types", () => {
    // Signup reads this straight off a form body.
    assert.equal(isAccountType("toString"), false);
    assert.equal(isAccountType("constructor"), false);
    assert.equal(isAccountType("__proto__"), false);
  });
});

describe("homeFor", () => {
  test("sends each side to its own home", () => {
    assert.equal(homeFor("personal"), "/dashboard");
    assert.equal(homeFor("business"), "/business");
    assert.equal(homeFor("supplier"), "/supplier");
  });

  test("an unknown or missing type falls back to personal", () => {
    // An account predating account types has no value; it must still land
    // somewhere sensible rather than nowhere.
    assert.equal(homeFor(undefined), "/dashboard");
    assert.equal(homeFor(null), "/dashboard");
    assert.equal(homeFor("nonsense"), "/dashboard");
  });
});
