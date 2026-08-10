import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { requestReceivedEmail } from "../../utils/credit-check-email.js";

const fmt = (n) => `KSh ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const build = (over = {}) =>
  requestReceivedEmail({
    request: {
      lender: "Equity Bank",
      amount_sought: 4500000,
      reference: "MTG-771",
      requested_at: "2026-08-07T09:00:00.000Z",
      ...(over.request || {})
    },
    purpose: over.purpose ?? { label: "Mortgage" },
    fmt,
    url: "https://cashflow.example/credit/checks"
  });

describe("the subject line", () => {
  test("says who is asking and what for", () => {
    assert.match(build().subject, /Equity Bank is asking to see your credit history/);
  });
});

describe("both bodies", () => {
  test("carry the ask: what for, how much, their reference", () => {
    const { text } = build();
    assert.match(text, /for mortgage of KSh 4,500,000\.00/);
    assert.match(text, /Their reference: MTG-771/);
  });

  test("say plainly that nothing has been shown yet", () => {
    const { text, html } = build();
    assert.match(text, /They have been shown nothing/);
    assert.match(html, /have been shown nothing/);
  });

  test("and that turning it down gives away nothing but the no", () => {
    assert.match(build().text, /turning it down shows them nothing but the fact that you did/);
  });

  test("report the name as a claim, not as a fact", () => {
    // Anyone with the code can type any name into that form. An email that
    // stated it as fact would be lending an unverified asker credibility.
    const { text, html } = build();
    assert.match(text, /Someone using the name "Equity Bank"/);
    assert.match(text, /has not checked who they are/);
    assert.match(html, /has not checked who they are/);
  });

  test("and tell the reader what to decide on instead", () => {
    assert.match(
      build().text,
      /because you are already dealing\s+with them, not because this email arrived/
    );
  });

  test("leave out an amount that was not given", () => {
    const { text } = build({ request: { amount_sought: null } });
    assert.match(text, /for mortgage\./);
    assert.doesNotMatch(text, /of KSh/);
  });

  test("and a reference that was not given", () => {
    assert.doesNotMatch(build({ request: { reference: null } }).text, /Their reference/);
  });

  test("link to the page that can answer it", () => {
    const { text, html } = build();
    assert.match(text, /https:\/\/cashflow\.example\/credit\/checks/);
    assert.match(html, /href="https:\/\/cashflow\.example\/credit\/checks"/);
  });
});

describe("what the lender typed", () => {
  test("is escaped before it reaches the HTML", () => {
    const { html } = build({ request: { lender: '<script>alert("x")</script>' } });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });

  test("including their reference, which is theirs to choose too", () => {
    const { html } = build({ request: { reference: "<img src=x onerror=1>" } });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });
});
