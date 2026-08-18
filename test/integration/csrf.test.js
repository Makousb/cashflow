// A cross-site form riding the victim's cookie is the attack this defends
// against. Node's fetch does not set Origin the way a browser does for a
// same-origin form post, so every other integration test in this suite
// exercises the "absent" path already, by accident, on every request they
// make — this file is the one that actually sets the header and proves the
// middleware does something with it.
process.env.CASHFLOW_NO_LISTEN = "1";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { closePool, dropUser, q, skipWithoutDb } from "./helpers.js";

let server;
let base;
let cookie = "";
let userId;

async function post(path, form, headers = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
    redirect: "manual"
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    if (c.startsWith("cashflow.sid")) cookie = c.split(";")[0];
  }
  return { status: res.status, text: await res.text() };
}

describe("cross-origin state changes", { skip: skipWithoutDb }, () => {
  before(async () => {
    const { default: app } = await import("../../app.js");
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const email = `csrf-${Date.now()}@example.test`;
    const signup = await post("/auth/register", {
      name: "CSRF Test", email, password: "a good long password", currency: "KES"
    });
    assert.equal(signup.status, 302, `signup should redirect, got ${signup.status}`);
    userId = (await q("SELECT id FROM users WHERE email = $1", [email]))[0].id;
  });

  after(async () => {
    await dropUser(userId);
    await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  test("a form posted from another origin, carrying the real session cookie, is refused", async () => {
    // This is the attack: a hostile page cannot read the httpOnly cookie, but
    // the browser attaches it to the request anyway — Origin is the one thing
    // in the request that tells the two apart, and it is the browser, not the
    // attacker's page, that sets it.
    const r = await post("/accounts", { name: "Hijacked", type: "cash" }, {
      Origin: "https://evil.example"
    });
    assert.equal(r.status, 403);
    assert.match(r.text, /didn't come from here/i);

    const rows = await q(
      "SELECT id FROM accounts WHERE user_id = $1 AND name = 'Hijacked'", [userId]
    );
    assert.equal(rows.length, 0, "the forged request must not have created anything");
  });

  test("a literal Origin: null with no Referer either is let through, not treated as an attack", async () => {
    // A real report against this app's own signup form: a Chrome ad blocker
    // strips Origin down to this opaque value AND strips Referer entirely on
    // an otherwise completely ordinary same-origin POST. This used to be
    // refused outright on the theory that "null" uniquely marks a sandboxed
    // iframe attack — but SameSite=Lax is what actually stops that attack in
    // any browser new enough to matter, and this exact header pattern turns
    // out to come from real, non-malicious browsers often enough that
    // blocking it categorically refuses more real visitors than attacks.
    const r = await post("/accounts", { name: "Ad Blocker Wallet", type: "cash" }, {
      Origin: "null"
    });
    assert.equal(r.status, 302);

    const rows = await q(
      "SELECT id FROM accounts WHERE user_id = $1 AND name = 'Ad Blocker Wallet'", [userId]
    );
    assert.equal(rows.length, 1);
  });

  test("Origin: null with a Referer that matches this app is let through", async () => {
    // A real report against this app's own signup form: Opera's built-in
    // privacy features send Origin: null on an entirely ordinary same-origin
    // POST. What tells that apart from the sandboxed-iframe attack the test
    // above guards against is Referer — an opaque, sandboxed origin has
    // nothing legitimate to put there, so the attack arrives with no usable
    // Referer either, while a browser suppressing only Origin still carries
    // an honest one.
    const r = await post("/accounts", { name: "Opera Wallet", type: "cash" }, {
      Origin: "null",
      Referer: base + "/accounts"
    });
    assert.equal(r.status, 302);

    const rows = await q(
      "SELECT id FROM accounts WHERE user_id = $1 AND name = 'Opera Wallet'", [userId]
    );
    assert.equal(rows.length, 1);
  });

  test("Origin: null with a Referer pointing elsewhere is still refused", async () => {
    // The fallback above only rescues a same-origin Referer — a forged or
    // cross-site one must not slip through just because Origin happens to
    // also be null.
    const r = await post("/accounts", { name: "Hijacked4", type: "cash" }, {
      Origin: "null",
      Referer: "https://evil.example/attack.html"
    });
    assert.equal(r.status, 403);

    const rows = await q(
      "SELECT id FROM accounts WHERE user_id = $1 AND name = 'Hijacked4'", [userId]
    );
    assert.equal(rows.length, 0);
  });

  test("a mismatched Referer is refused the same way, when there is no Origin", async () => {
    const r = await post("/accounts", { name: "Hijacked2", type: "cash" }, {
      Referer: "https://evil.example/attack.html"
    });
    assert.equal(r.status, 403);
  });

  test("the app's own form submission — matching Origin — still works", async () => {
    const r = await post("/accounts", { name: "Legit Wallet", type: "cash" }, {
      Origin: base
    });
    assert.equal(r.status, 302);

    const rows = await q(
      "SELECT id FROM accounts WHERE user_id = $1 AND name = 'Legit Wallet'", [userId]
    );
    assert.equal(rows.length, 1);
  });

  test("no Origin and no Referer at all is let through, not refused", async () => {
    // What every other test in this suite already relies on implicitly:
    // Node's fetch does not send these the way a browser would, and a real
    // browser or privacy tool can legitimately omit both too.
    const r = await post("/accounts", { name: "No Header Wallet", type: "cash" });
    assert.equal(r.status, 302);
  });

  test("a GET is never checked, whatever Origin it carries", async () => {
    const res = await fetch(base + "/accounts", {
      headers: { Cookie: cookie, Origin: "https://evil.example" }
    });
    assert.equal(res.status, 200);
  });
});
