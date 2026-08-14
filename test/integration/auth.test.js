// Login and registration over real HTTP, on their own ephemeral server —
// separate from pages.test.js because this exercises auth specifically
// (timing, the rate limiter wired into the routes) rather than page
// rendering, and shares its server-boot pattern rather than its process.
process.env.CASHFLOW_NO_LISTEN = "1";

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { closePool, dropUser, q, skipWithoutDb } from "./helpers.js";

let server;
let base;

async function post(path, form, cookie = "") {
  const start = performance.now();
  const res = await fetch(base + path, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    redirect: "manual"
  });
  const elapsedMs = performance.now() - start;
  const setCookie = (res.headers.getSetCookie?.() || [])
    .find((c) => c.startsWith("cashflow.sid"));
  return {
    status: res.status,
    location: res.headers.get("location"),
    cookie: setCookie ? setCookie.split(";")[0] : null,
    text: await res.text(),
    elapsedMs
  };
}

function flashText(html) {
  const m = /<div class="flash flash-error">([\s\S]*?)<\/div>/.exec(html);
  return m ? m[1].trim() : null;
}

describe("registering", { skip: skipWithoutDb }, () => {
  let server;
  let base;

  before(async () => {
    const { default: app } = await import("../../app.js");
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function post(path, form) {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      redirect: "manual"
    });
    return { status: res.status, location: res.headers.get("location") };
  }

  test("a garbage email is refused, not stored", async () => {
    const email = "not-an-email-at-all";
    const r = await post("/auth/register", {
      name: "Bad Email", email, password: "a good long password", currency: "KES"
    });
    assert.equal(r.status, 302);
    assert.equal(r.location, "/auth/register", "a refusal stays on the register page, not through to /dashboard");

    const rows = await q("SELECT id FROM users WHERE email = $1", [email]);
    assert.equal(rows.length, 0, "the malformed address must not have been written");
  });

  test("an ordinary email still registers", async () => {
    const email = `valid-${Date.now()}@example.test`;
    const r = await post("/auth/register", {
      name: "Good Email", email, password: "a good long password", currency: "KES"
    });
    assert.equal(r.status, 302);
    assert.equal(r.location, "/dashboard");

    const rows = await q("SELECT id FROM users WHERE email = $1", [email]);
    assert.equal(rows.length, 1);
    await dropUser(rows[0].id);
  });
});

describe("signing in", { skip: skipWithoutDb }, () => {
  const email = `auth-timing-${Date.now()}@example.test`;
  const password = "a good long password";
  let userId;

  before(async () => {
    const { default: app } = await import("../../app.js");
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const signup = await post("/auth/register", { name: "Timing Test", email, password, currency: "KES" });
    assert.equal(signup.status, 302, `signup should redirect, got ${signup.status}`);
    userId = (await q("SELECT id FROM users WHERE email = $1", [email]))[0].id;
  });

  after(async () => {
    await dropUser(userId);
    await new Promise((resolve) => server.close(resolve));
    await closePool();
  });

  test("a real account with the wrong password is refused", async () => {
    const r = await post("/auth/login", { email, password: "not the password" });
    assert.equal(r.status, 302);
    assert.equal(r.location, "/auth/login");
    const page = await (await fetch(base + "/auth/login", { headers: { Cookie: r.cookie || "" } })).text();
    assert.match(flashText(page) || "", /invalid email or password/i);
  });

  test("an email nobody registered gets the identical message", async () => {
    const r = await post("/auth/login", { email: `nobody-${Date.now()}@example.test`, password: "whatever" });
    assert.equal(r.status, 302);
    const page = await (await fetch(base + "/auth/login", { headers: { Cookie: r.cookie || "" } })).text();
    assert.match(flashText(page) || "", /invalid email or password/i);
  });

  test("an unknown email still costs roughly a real bcrypt compare, not nothing", async () => {
    // Loose on purpose — this asserts the fix's shape (the dummy hash is
    // actually compared against, not skipped) without pinning a wall-clock
    // number a slower CI box would fail. Skipping bcrypt entirely for an
    // unknown email — the bug this replaced — finishes in low single-digit
    // milliseconds; actually calling it does not, even on fast hardware.
    const r = await post("/auth/login", { email: `nobody2-${Date.now()}@example.test`, password: "whatever" });
    assert.ok(
      r.elapsedMs > 15,
      `unknown-email login returned in ${r.elapsedMs.toFixed(1)}ms — too fast to have run bcrypt.compare, ` +
      "meaning the email's existence is once again visible in the timing"
    );
  });

  test("the real password still gets in", async () => {
    const r = await post("/auth/login", { email, password });
    assert.equal(r.status, 302);
    assert.equal(r.location, "/dashboard");
    assert.ok(r.cookie, "a successful login must set a session cookie");
  });
});
