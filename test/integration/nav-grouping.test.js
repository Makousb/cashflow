import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { createBusiness, deleteBusiness, hasAnyBusiness } from "../../db/queries/business.js";
import { createSupplier, hasAnySupplier } from "../../db/queries/suppliers.js";
import { closePool, dropUser, makeUser, skipWithoutDb } from "./helpers.js";

// Every account gets a personal wallet, so the personal nav links are
// universal; Business and Supplier are the two that used to show to
// everyone regardless. These back the nav hint the app.js middleware
// computes on every authenticated page — see the comment there for why it
// falls back to account_type rather than being hasAnyX alone.
describe("whether Business/Supplier belong in the nav", { skip: skipWithoutDb }, () => {
  let user;

  before(async () => {
    user = await makeUser("nav-grouping");
  });

  after(async () => {
    await dropUser(user?.id);
  });

  test("false for a plain login with neither", async () => {
    assert.equal(await hasAnyBusiness(user.id), false);
    assert.equal(await hasAnySupplier(user.id), false);
  });

  test("true once a business exists", async () => {
    const business = await createBusiness({ userId: user.id, name: "Test Co", industry: null });
    assert.equal(await hasAnyBusiness(user.id), true);
    assert.equal(await hasAnySupplier(user.id), false, "creating a business must not flip the other flag");

    await deleteBusiness(business.id, user.id);
    assert.equal(
      await hasAnyBusiness(user.id), false,
      "the query itself reports false once the row is gone — the account_type " +
      "fallback that keeps the nav link visible lives in app.js, not here"
    );
  });

  test("true once a supplier account exists", async () => {
    await createSupplier({ userId: user.id, name: "Test Supply", industry: null, leadTimeDays: 3 });
    assert.equal(await hasAnySupplier(user.id), true);
  });

  test("never true for somebody else's business or supplier account", async () => {
    const stranger = await makeUser("nav-grouping-stranger");
    try {
      assert.equal(await hasAnyBusiness(stranger.id), false);
      assert.equal(await hasAnySupplier(stranger.id), false);
    } finally {
      await dropUser(stranger.id);
    }
  });

  after(closePool);
});
