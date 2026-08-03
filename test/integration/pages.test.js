// Every page, actually rendered.
//
// This exists because `npm run check` parses files but cannot see a missing
// import: the module loads fine and only explodes when the route is hit. That
// shipped a 500 on the business dashboard once, and nothing in the suite
// noticed, because everything else tested the layers underneath the routes.
//
// The app is started on an ephemeral port with a real session, so a page that
// throws shows up as a 500 here rather than in front of somebody.
process.env.CASHFLOW_NO_LISTEN = "1";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { closePool, dropUser, q, skipWithoutDb } from "./helpers.js";

let server;
let base;
let cookie = "";
let userId;
let businessId;

async function visit(path) {
  const res = await fetch(base + path, {
    headers: { Cookie: cookie },
    redirect: "manual"
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    if (c.startsWith("cashflow.sid")) cookie = c.split(";")[0];
  }
  return { status: res.status, location: res.headers.get("location"), text: await res.text() };
}

async function post(path, form) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    redirect: "manual"
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    if (c.startsWith("cashflow.sid")) cookie = c.split(";")[0];
  }
  return { status: res.status, location: res.headers.get("location") };
}

describe("every page renders", { skip: skipWithoutDb }, () => {
  before(async () => {
    const { default: app } = await import("../../app.js");
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    // A real signup, so the session and the user's own rows are genuine.
    const email = `pages-${Date.now()}@example.test`;
    const signup = await post("/auth/register", {
      name: "Page Test", email, password: "a good long password", currency: "KES"
    });
    assert.equal(signup.status, 302, "signup should succeed");
    userId = (await q("SELECT id FROM users WHERE email = $1", [email]))[0].id;

    const created = await post("/business", { name: "Page Test Co", industry: "Retail" });
    businessId = Number(/\/business\/(\d+)/.exec(created.location || "")?.[1]);
    assert.ok(businessId, "a business should have been created");
  });

  after(async () => {
    await dropUser(userId);
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  const personal = [
    "/", "/dashboard", "/transactions", "/recurring", "/receipts", "/budgets",
    "/goals", "/loans", "/reports", "/accounts", "/settings", "/business"
  ];

  for (const path of personal) {
    test(`GET ${path}`, async () => {
      const res = await visit(path);
      assert.equal(res.status, 200, `${path} returned ${res.status}`);
    });
  }

  const business = [
    "", "/inventory", "/sales", "/payroll", "/tax", "/planning", "/statements",
    "/invoices", "/bills", "/advisor", "/supply", "/supply/reports",
    "/accountant", "/accountant/entries"
  ];

  for (const suffix of business) {
    test(`GET /business/:id${suffix || " (dashboard)"}`, async () => {
      const res = await visit(`/business/${businessId}${suffix}`);
      assert.equal(res.status, 200, `${suffix} returned ${res.status}`);
    });
  }

  test("a business with no supplier redirects rather than erroring", async () => {
    const res = await visit(`/business/${businessId}/supply/new`);
    assert.equal(res.status, 302, "no partners yet, so it should redirect");
  });

  test("an unknown business redirects instead of throwing", async () => {
    const res = await visit("/business/99999999");
    assert.equal(res.status, 302);
  });

  test("signed out, a private page sends you to log in", async () => {
    const kept = cookie;
    cookie = "";
    const res = await visit("/dashboard");
    assert.equal(res.status, 302);
    assert.match(res.location || "", /login/);
    cookie = kept;
  });
});

// One teardown for the whole file — every suite in it shares the same pool.
after(async () => {
  await closePool();
});
