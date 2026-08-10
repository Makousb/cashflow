// A lender's sight of somebody's history, driven through the real app.
//
// What is being tested is mostly what does not happen: no page without a token,
// nothing once it is stopped, nothing once it has run out, and nothing about
// anybody else. The token is the whole of the authority, so these are the
// assertions that matter most in this file.
process.env.CASHFLOW_NO_LISTEN = "1";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { closePool, dropUser, q, skipWithoutDb } from "./helpers.js";

let server;
let base;
let cookie = "";
let userId;

async function req(method, path, form) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Cookie: cookie,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    redirect: "manual"
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    if (c.startsWith("cashflow.sid")) cookie = c.split(";")[0];
  }
  return { status: res.status, location: res.headers.get("location"), text: await res.text() };
}

const pageText = (html) => (html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("giving a lender a look", { skip: skipWithoutDb }, () => {
  let token;

  before(async () => {
    const { default: app } = await import("../../app.js");
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const email = `check-${Date.now()}@example.test`;
    const signup = await req("POST", "/auth/register", {
      name: "Asha Mwangi", email, password: "a good long password", currency: "KES"
    });
    assert.equal(signup.status, 302, `signup returned ${signup.status}`);
    assert.ok(cookie, "signup set no session cookie");
    userId = (await q("SELECT id FROM users WHERE email = $1", [email]))[0].id;

    // Something to have a history of, and a purchase whose name must not travel.
    await q(
      `INSERT INTO credit_facilities (user_id, product, label, principal, opened_on, status)
       VALUES ($1, 'bnpl', 'Divorce lawyer', 12000, CURRENT_DATE - INTERVAL '4 months', 'active')`,
      [userId]
    );
    await q(
      `INSERT INTO transactions (user_id, kind, amount, note, occurred_on)
       VALUES ($1, 'expense', 5000, 'Something private', CURRENT_DATE)`,
      [userId]
    );
  });

  after(async () => {
    await dropUser(userId);
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  test("a check is made for a named lender and a purpose", async () => {
    const made = await req("POST", "/credit/checks", {
      lender: "Equity Bank", purpose: "mortgage", amountSought: "4500000", days: "30"
    });
    assert.equal(made.status, 302);

    const page = await req("GET", "/credit/checks");
    assert.match(pageText(page.text), /Equity Bank/);
    assert.match(pageText(page.text), /Mortgage/);

    token = (await q("SELECT token FROM credit_checks WHERE user_id = $1", [userId]))[0].token;
    assert.ok(token && token.length > 30, "the token is the whole authority, so it is long");
  });

  test("the lender sees the standing without logging in", async () => {
    const saved = cookie;
    cookie = "";
    const seen = await req("GET", `/credit-check/${token}`);
    cookie = saved;

    assert.equal(seen.status, 200);
    const text = pageText(seen.text);
    assert.match(text, /Credit history — Asha Mwangi/);
    assert.match(text, /Equity Bank/);
  });

  test("but not what anything was called, nor what was spent", async () => {
    const saved = cookie;
    cookie = "";
    const seen = await req("GET", `/credit-check/${token}`);
    cookie = saved;

    const text = pageText(seen.text);
    assert.doesNotMatch(text, /Divorce lawyer/, "a label is the borrower's business");
    assert.doesNotMatch(text, /Something private/, "spending is not a credit history");
    assert.doesNotMatch(text, /@example\.test/, "nor is an email address");
  });

  test("every opening is counted back to the person", async () => {
    const page = await req("GET", "/credit/checks");
    assert.match(pageText(page.text), /Opened \d+ times?/);
    const views = await q(
      `SELECT COUNT(*)::int AS n FROM credit_check_views v
       JOIN credit_checks c ON c.id = v.check_id WHERE c.user_id = $1`,
      [userId]
    );
    assert.ok(views[0].n >= 2, "the views above should have been recorded");
  });

  test("a token nobody issued shows nothing", async () => {
    const saved = cookie;
    cookie = "";
    const seen = await req("GET", "/credit-check/not-a-real-token-at-all");
    cookie = saved;

    assert.equal(seen.status, 404);
    assert.doesNotMatch(pageText(seen.text), /Asha Mwangi/);
  });

  test("stopping it stops it", async () => {
    const id = (await q("SELECT id FROM credit_checks WHERE user_id = $1", [userId]))[0].id;
    const stopped = await req("POST", `/credit/checks/${id}/stop`);
    assert.equal(stopped.status, 302);

    const saved = cookie;
    cookie = "";
    const seen = await req("GET", `/credit-check/${token}`);
    cookie = saved;

    assert.equal(seen.status, 404);
    assert.doesNotMatch(pageText(seen.text), /Asha Mwangi/);
  });

  test("a check that has run out is as good as stopped", async () => {
    await req("POST", "/credit/checks", {
      lender: "Co-op Bank", purpose: "car_loan", days: "5"
    });
    const row = (await q(
      "SELECT id, token FROM credit_checks WHERE user_id = $1 AND lender = 'Co-op Bank'",
      [userId]
    ))[0];
    await q(
      "UPDATE credit_checks SET expires_on = CURRENT_DATE - 1 WHERE id = $1",
      [row.id]
    );

    const saved = cookie;
    cookie = "";
    const seen = await req("GET", `/credit-check/${row.token}`);
    cookie = saved;

    assert.equal(seen.status, 404);
  });

  test("the checks page is nobody else's to open", async () => {
    const saved = cookie;
    cookie = "";
    const seen = await req("GET", "/credit/checks");
    cookie = saved;

    assert.equal(seen.status, 302);
    assert.equal(seen.location, "/auth/login");
  });

  test("and one person cannot stop another's check", async () => {
    const otherEmail = `other-${Date.now()}@example.test`;
    const mine = (await q("SELECT id FROM credit_checks WHERE user_id = $1 LIMIT 1", [userId]))[0].id;

    const saved = cookie;
    cookie = "";
    await req("POST", "/auth/register", {
      name: "Someone Else", email: otherEmail, password: "a good long password", currency: "KES"
    });
    const attempt = await req("POST", `/credit/checks/${mine}/stop`);
    const otherId = (await q("SELECT id FROM users WHERE email = $1", [otherEmail]))[0].id;
    cookie = saved;

    assert.equal(attempt.status, 302);
    const still = await q("SELECT revoked_at FROM credit_checks WHERE id = $1", [mine]);
    assert.ok(still.length === 1, "the check must still be there");
    await dropUser(otherId);
  });
});

// One teardown for the whole file — every suite in it shares the same pool.
after(async () => {
  await closePool();
});
