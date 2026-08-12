import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  createSubsidiary,
  groupFigures,
  groupFor,
  setParent,
  setPlace
} from "../../db/queries/group.js";
import { addBusinessTransaction } from "../../db/queries/business.js";
import { listAccounts } from "../../db/queries/ledger.js";
import { consolidate } from "../../utils/jurisdictions.js";
import { closePool, dropUser, makeBusiness, makeUser, skipWithoutDb } from "./helpers.js";

const TODAY = "2026-08-11";

describe("opening branches", { skip: skipWithoutDb }, () => {
  let user;
  let parent;
  let kampala;

  before(async () => {
    user = await makeUser("group-branches");
    parent = await makeBusiness(user.id, "Njeri Holdings");
  });
  after(async () => { await dropUser(user?.id); });

  test("a branch is a business in its own right", async () => {
    kampala = await createSubsidiary({
      parentId: parent.id, userId: user.id,
      name: "Njeri Kampala", industry: "Retail", jurisdiction: "UG", currency: "UGX"
    });

    assert.equal(kampala.parent_id, parent.id);
    assert.equal(kampala.jurisdiction, "UG");
    assert.ok(kampala.supply_code, "it can trade in the supply chain like any other");
  });

  test("and opens with its own chart of accounts", async () => {
    const accounts = await listAccounts(kampala.id, user.id);
    assert.ok(accounts.length >= 20);
    assert.ok(accounts.some((a) => a.key === "cash"));
  });

  test("the group reads the same from the parent or from a branch", async () => {
    const fromTop = await groupFor(parent.id, user.id);
    const fromBranch = await groupFor(kampala.id, user.id);

    assert.equal(fromTop.rootId, parent.id);
    assert.equal(fromBranch.rootId, parent.id, "a branch still sees the whole group");
    assert.equal(fromTop.members.length, 2);
    assert.deepEqual(
      fromTop.members.map((m) => m.id).sort(),
      fromBranch.members.map((m) => m.id).sort()
    );
  });

  test("branches of branches are in it too", async () => {
    const sub = await createSubsidiary({
      parentId: kampala.id, userId: user.id,
      name: "Njeri Jinja", industry: "Retail", jurisdiction: "UG", currency: "UGX"
    });

    const group = await groupFor(parent.id, user.id);
    assert.equal(group.members.length, 3);
    assert.ok(group.members.some((m) => m.id === sub.id));
  });
});

describe("moving a business around the group", { skip: skipWithoutDb }, () => {
  let user;
  let parent;
  let branch;
  let grandchild;

  before(async () => {
    user = await makeUser("group-moves");
    parent = await makeBusiness(user.id, "Top");
    branch = await createSubsidiary({
      parentId: parent.id, userId: user.id, name: "Middle", jurisdiction: "KE", currency: "KES"
    });
    grandchild = await createSubsidiary({
      parentId: branch.id, userId: user.id, name: "Bottom", jurisdiction: "KE", currency: "KES"
    });
  });
  after(async () => { await dropUser(user?.id); });

  test("a business cannot be made its own parent", async () => {
    const out = await setParent({ businessId: branch.id, userId: user.id, parentId: branch.id });
    assert.equal(out.ok, false);
    assert.match(out.reason, /its own parent/);
  });

  test("nor put underneath one of its own branches", async () => {
    // Top under Bottom would make a cycle, and the recursive walks would hang.
    const out = await setParent({
      businessId: parent.id, userId: user.id, parentId: grandchild.id
    });
    assert.equal(out.ok, false);
    assert.match(out.reason, /its own branches/);

    // And the group still reads, which is the thing the guard protects.
    const group = await groupFor(parent.id, user.id);
    assert.equal(group.members.length, 3);
  });

  test("but can be moved to a legitimate parent", async () => {
    const out = await setParent({
      businessId: grandchild.id, userId: user.id, parentId: parent.id
    });
    assert.equal(out.ok, true);
    assert.equal(out.business.parent_id, parent.id);
  });

  test("or set loose to stand on its own", async () => {
    const out = await setParent({ businessId: grandchild.id, userId: user.id, parentId: null });
    assert.equal(out.ok, true);
    assert.equal(out.business.parent_id, null);

    assert.equal((await groupFor(parent.id, user.id)).members.length, 2);
    assert.equal((await groupFor(grandchild.id, user.id)).members.length, 1);
  });
});

describe("consolidating real ledgers", { skip: skipWithoutDb }, () => {
  let user;
  let parent;
  let branch;

  before(async () => {
    user = await makeUser("group-consolidate");
    parent = await makeBusiness(user.id, "Parent Co");
    await setPlace({
      businessId: parent.id, userId: user.id,
      jurisdiction: "KE", currency: "KES", incomeTaxRate: null, salesTaxRate: null
    });

    branch = await createSubsidiary({
      parentId: parent.id, userId: user.id,
      name: "Branch Co", jurisdiction: "UG", currency: "UGX"
    });

    // Real postings, so the figures come off actual ledgers.
    await addBusinessTransaction({
      businessId: parent.id, userId: user.id, kind: "income",
      amount: 500000, category: "Sales", note: "Parent sales", occurredOn: TODAY
    });
    await addBusinessTransaction({
      businessId: parent.id, userId: user.id, kind: "expense",
      amount: 200000, category: "Rent", note: "Parent rent", occurredOn: TODAY
    });
    await addBusinessTransaction({
      businessId: branch.id, userId: user.id, kind: "income",
      amount: 20000000, category: "Sales", note: "Branch sales", occurredOn: TODAY
    });
  });
  after(async () => { await dropUser(user?.id); });

  test("each entity's figures come straight off its own ledger", async () => {
    const figures = await groupFigures([parent.id, branch.id], user.id);
    assert.equal(figures.get(parent.id).revenue, 500000);
    assert.equal(figures.get(parent.id).expenses, 200000);
    assert.equal(figures.get(parent.id).netProfit, 300000);
    assert.equal(figures.get(branch.id).revenue, 20000000);
  });

  test("an entity that has posted nothing is still in the group, at zero", async () => {
    const quiet = await createSubsidiary({
      parentId: parent.id, userId: user.id, name: "Quiet Co", jurisdiction: "KE", currency: "KES"
    });
    const figures = await groupFigures([parent.id, branch.id, quiet.id], user.id);
    assert.equal(figures.get(quiet.id).revenue, 0);
    assert.equal(figures.size, 3);
  });

  test("and the group total converts before it adds", async () => {
    const { members } = await groupFor(parent.id, user.id);
    const figures = await groupFigures(members.map((m) => m.id), user.id);

    const out = consolidate({
      currency: "KES",
      rateFor: (from, to) => (from === "UGX" && to === "KES" ? 0.035 : 1),
      entities: members.map((m) => ({
        business: m,
        currency: m.base_currency || "KES",
        figures: figures.get(m.id)
      }))
    });

    // 500,000 KES + (20,000,000 UGX × 0.035 = 700,000 KES).
    assert.equal(out.totals.revenue, 1200000);
    assert.equal(out.multiCurrency, true);
  });
});

describe("where a business trades", { skip: skipWithoutDb }, () => {
  let user;
  let business;

  before(async () => {
    user = await makeUser("group-place");
    business = await makeBusiness(user.id, "Placed Co");
  });
  after(async () => { await dropUser(user?.id); });

  test("is recorded, along with what it keeps its books in", async () => {
    const out = await setPlace({
      businessId: business.id, userId: user.id,
      jurisdiction: "NG", currency: "NGN", incomeTaxRate: null, salesTaxRate: null
    });
    assert.equal(out.jurisdiction, "NG");
    assert.equal(out.base_currency, "NGN");
    assert.equal(out.income_tax_rate, null, "null means use Nigeria's rate");
  });

  test("an override is kept, and zero survives as a real rate", async () => {
    const out = await setPlace({
      businessId: business.id, userId: user.id,
      jurisdiction: "NG", currency: "NGN", incomeTaxRate: 20, salesTaxRate: 0
    });
    assert.equal(Number(out.income_tax_rate), 20);
    assert.equal(Number(out.sales_tax_rate), 0);
  });

  test("somebody else's business cannot be moved", async () => {
    const other = await makeUser("group-place-other");
    try {
      const out = await setPlace({
        businessId: business.id, userId: other.id,
        jurisdiction: "GB", currency: "GBP", incomeTaxRate: null, salesTaxRate: null
      });
      assert.equal(out, null);
    } finally {
      await dropUser(other.id);
    }
  });
});

after(async () => { await closePool(); });
