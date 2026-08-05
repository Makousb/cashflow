import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { reviewEmail } from "../../utils/review-email.js";
import { reviewLedger, taxPosition } from "../../utils/accounting.js";

const fmt = (n) => `KSh ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const business = { name: "Mama Njeri Grocers", id: 1 };
const tax = taxPosition({ accrualProfit: 143350, rate: 30, payrollDeductions: 6900, setAside: 10000 });

const build = (over = {}) =>
  reviewEmail({
    business,
    tax,
    review: over.review || reviewLedger({ tax, today: "2026-08-03", fmt }),
    narrative: over.narrative ?? "Three things need attention before month end.",
    fmt,
    url: over.url ?? "https://cashflow.example/business/1/accountant",
    // The 1st, because that is when a monthly close actually runs and the only
    // day of the month on which naming it wrongly shows: read as UTC midnight
    // this lands in July, and the subject assertion below would say so. Any
    // other date hides that, which is why this one is not the 3rd.
    when: over.when ?? "2026-08-01"
  });

describe("the subject line", () => {
  test("leads with what was found", () => {
    const { subject } = build();
    assert.match(subject, /Mama Njeri Grocers/);
    assert.match(subject, /1 finding/);
    assert.match(subject, /August 2026/);
  });

  test("calls out how many need attention", () => {
    const review = reviewLedger({
      transactions: [
        { id: 1, kind: "expense", amount: 900, category: "Other", occurred_on: "2026-08-01" }
      ],
      tax, today: "2026-08-03", fmt
    });
    assert.match(build({ review }).subject, /2 findings \(2 needing attention\)/);
  });

  test("says so plainly when there is nothing to fix", () => {
    const clean = reviewLedger({ today: "2026-08-03" });
    assert.match(build({ review: clean }).subject, /nothing to fix/);
  });
});

describe("both bodies carry the figures", () => {
  test("the plain text lists the tax position", () => {
    const { text } = build();
    assert.match(text, /Taxable profit: KSh 143,350\.00/);
    assert.match(text, /Tax owed: KSh 49,905\.00/);
    assert.match(text, /Still to find: KSh 39,905\.00/);
  });

  test("the note is included", () => {
    assert.match(build().text, /Three things need attention before month end\./);
    assert.match(build().html, /Three things need attention before month end\./);
  });

  test("findings appear with their severity", () => {
    const { text } = build();
    assert.match(text, /\[high\] KSh 39,905\.00 of tax is not set aside/);
  });

  test("a link back is offered when there is one", () => {
    assert.match(build().text, /https:\/\/cashflow\.example\/business\/1\/accountant/);
    assert.match(build().html, /href="https:\/\/cashflow\.example\/business\/1\/accountant"/);
  });

  test("and omitted cleanly when there is not", () => {
    const { html } = build({ url: "" });
    assert.ok(!html.includes("Open the review"));
  });

  test("both bodies carry the estimates caveat", () => {
    const { text, html } = build();
    assert.match(text, /not a filing/);
    assert.match(html, /not a filing/);
  });

  test("a clean close reads as clean", () => {
    const clean = reviewLedger({ today: "2026-08-03" });
    assert.match(build({ review: clean }).text, /Nothing to correct/);
    assert.match(build({ review: clean }).html, /the books are clean/);
  });
});

describe("the HTML body is escaped", () => {
  // Findings quote vendor names, categories and notes the owner typed. None of
  // that can be trusted to be free of markup.
  test("a business name with markup cannot break out", () => {
    const { html } = reviewEmail({
      business: { name: '<script>alert(1)</script>', id: 1 },
      tax,
      review: reviewLedger({ today: "2026-08-03" }),
      narrative: "fine", fmt, url: "", when: "2026-08-03"
    });
    assert.ok(!html.includes("<script>"), "raw script tag must not survive");
    assert.match(html, /&lt;script&gt;/);
  });

  test("a vendor name with markup is escaped inside a finding", () => {
    const review = reviewLedger({
      bills: [{
        id: 3, status: "unpaid", amount: 4100, due_on: "2026-07-01",
        vendor: '<img src=x onerror="alert(1)">'
      }],
      today: "2026-08-03"
    });
    const { html } = build({ review });
    assert.ok(!html.includes("<img src=x"), "raw tag must not survive");
    assert.match(html, /&lt;img src=x/);
  });

  test("a narrative with markup is escaped", () => {
    const { html } = build({ narrative: '</p><script>alert(1)</script>' });
    assert.ok(!html.includes("<script>"));
  });

  test("quotes and ampersands survive as text", () => {
    const { html } = reviewEmail({
      business: { name: `Ben & Jerry's`, id: 1 },
      tax, review: reviewLedger({ today: "2026-08-03" }),
      narrative: "fine", fmt, url: "", when: "2026-08-03"
    });
    assert.match(html, /Ben &amp; Jerry&#39;s/);
  });

  test("the plain text body is left alone — it is not markup", () => {
    const { text } = reviewEmail({
      business: { name: "Ben & Jerry's", id: 1 },
      tax, review: reviewLedger({ today: "2026-08-03" }),
      narrative: "fine", fmt, url: "", when: "2026-08-03"
    });
    assert.match(text, /Ben & Jerry's/);
  });
});
