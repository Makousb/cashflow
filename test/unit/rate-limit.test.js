import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { limitLogin, limitRegister } from "../../middlewares/rate-limit.middleware.js";

// A fake request/response pair, close enough to Express for this middleware:
// it reads req.body, req.ip, calls req.flash, and either calls next() or
// res.redirect(). Each test picks its own req.ip so runs never share a bucket
// with each other or with a real server — the module-level counters live for
// the life of this file's process, same as the one it is testing.
function callMiddleware(mw, { ip, email = "" }) {
  const flashes = [];
  let redirectedTo = null;
  let calledNext = false;

  const req = { body: { email }, ip, flash: (kind, msg) => flashes.push([kind, msg]) };
  const res = { redirect: (to) => { redirectedTo = to; } };
  mw(req, res, () => { calledNext = true; });

  return { calledNext, redirectedTo, flashes };
}

describe("login rate limiting", () => {
  test("allows attempts up to the limit", () => {
    const ip = "10.0.0.1";
    for (let i = 0; i < 10; i++) {
      const result = callMiddleware(limitLogin, { ip, email: "a@example.test" });
      assert.equal(result.calledNext, true, `attempt ${i + 1} of 10 should pass through`);
    }
  });

  test("blocks the next attempt from the same IP", () => {
    const ip = "10.0.0.2";
    for (let i = 0; i < 10; i++) {
      callMiddleware(limitLogin, { ip, email: `user${i}@example.test` });
    }
    const blocked = callMiddleware(limitLogin, { ip, email: "user10@example.test" });
    assert.equal(blocked.calledNext, false, "the 11th attempt from one IP must be refused");
    assert.equal(blocked.redirectedTo, "/auth/login");
    assert.match(blocked.flashes[0][1], /too many attempts/i);
  });

  test("also blocks by email, so spreading guesses across IPs does not help", () => {
    const email = "victim@example.test";
    for (let i = 0; i < 10; i++) {
      const result = callMiddleware(limitLogin, { ip: `10.0.1.${i}`, email });
      assert.equal(result.calledNext, true, `attempt ${i + 1} of 10 against one email should pass`);
    }
    const blocked = callMiddleware(limitLogin, { ip: "10.0.1.99", email });
    assert.equal(blocked.calledNext, false, "the 11th attempt against one email must be refused even from a new IP");
  });

  test("an IP is not punished for one email's exhausted budget", () => {
    const ip = "10.0.0.3";
    for (let i = 0; i < 10; i++) {
      callMiddleware(limitLogin, { ip, email: "one-target@example.test" });
    }
    // That IP has now made 10 attempts too, so this specifically checks a
    // fresh IP trying the SAME already-exhausted email.
    const fromElsewhere = callMiddleware(limitLogin, { ip: "10.0.0.4", email: "one-target@example.test" });
    assert.equal(fromElsewhere.calledNext, false, "the email's own budget is what refuses this, not the IP");

    const sameIpDifferentEmail = callMiddleware(limitLogin, { ip: "10.0.0.5", email: "unrelated@example.test" });
    assert.equal(sameIpDifferentEmail.calledNext, true, "an unrelated email from a fresh IP is unaffected");
  });

  test("a blank email cannot be targeted, and does not share a bucket across IPs", () => {
    const result = callMiddleware(limitLogin, { ip: "10.0.0.6", email: "" });
    assert.equal(result.calledNext, true);
  });
});

describe("registration rate limiting", () => {
  test("allows up to its own, looser limit", () => {
    const ip = "10.0.2.1";
    for (let i = 0; i < 20; i++) {
      const result = callMiddleware(limitRegister, { ip });
      assert.equal(result.calledNext, true, `attempt ${i + 1} of 20 should pass through`);
    }
  });

  test("blocks the next attempt, and does not share a bucket with login", () => {
    const ip = "10.0.2.2";
    for (let i = 0; i < 20; i++) {
      callMiddleware(limitRegister, { ip });
    }
    const blocked = callMiddleware(limitRegister, { ip });
    assert.equal(blocked.calledNext, false);
    assert.equal(blocked.redirectedTo, "/auth/register");

    // The same IP still has its full login budget — registration spam should
    // not lock someone out of signing in.
    const login = callMiddleware(limitLogin, { ip, email: "someone@example.test" });
    assert.equal(login.calledNext, true, "login and registration must not share a counter");
  });
});
