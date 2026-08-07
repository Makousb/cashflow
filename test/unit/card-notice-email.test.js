import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { minimumDueSoonEmail, missedMinimumEmail } from "../../utils/card-notice-email.js";

const fmt = (n) => `KSh ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const build = (over = {}) =>
  missedMinimumEmail({
    facility: { label: "Everyday card", ...(over.facility || {}) },
    statement: {
      cycle: "2026-06", closedOn: "2026-06-30", dueOn: "2026-07-21",
      balance: 4100, interest: 100, minimumDue: 205, paidTowards: 0,
      ...(over.statement || {})
    },
    standing: {
      balance: 4202.5, monthlyInterest: 105.06, minimumDue: 205, missedCount: 1,
      ...(over.standing || {})
    },
    fmt,
    url: over.url ?? "https://cashflow.example/credit"
  });

describe("the subject line", () => {
  test("names the card and the date it was due", () => {
    const { subject } = build();
    assert.match(subject, /Everyday card/);
    assert.match(subject, /Jul 21, 2026/);
    assert.match(subject, /missed/i);
  });
});

describe("both bodies carry the figures", () => {
  test("the statement, the minimum, and what is owed now", () => {
    const { text } = build();
    assert.match(text, /Statement drawn Jun 30, 2026: KSh 4,100\.00/);
    assert.match(text, /Minimum asked for: KSh 205\.00/);
    assert.match(text, /balance now stands at KSh 4,202\.50/);
  });

  test("what it costs to leave it, since that is the actual consequence", () => {
    const { text, html } = build();
    assert.match(text, /KSh 105\.06 in interest next month/);
    assert.match(html, /KSh 105\.06/);
  });

  test("names the fee that was charged, and what it was a tenth of", () => {
    const { text, html } = build({ statement: { lateFee: 20.5, shortfall: 205 } });
    assert.match(text, /late fee of KSh 20\.50 has been added — a tenth of the KSh 205\.00/);
    assert.match(html, /KSh 20\.50/);
  });

  test("and mentions no fee when none was charged", () => {
    // A statement inside its window has not been charged for anything, and an
    // email inventing a fee would be a lie about somebody's money.
    const { text, html } = build({ statement: { lateFee: 0 } });
    assert.doesNotMatch(text, /late fee/i);
    assert.doesNotMatch(html, /late fee/i);
  });

  test("a part payment is credited rather than ignored", () => {
    const { text } = build({ statement: { paidTowards: 100 } });
    assert.match(text, /Paid towards it: KSh 100\.00 — KSh 105\.00 short/);
  });

  test("nothing paid says so", () => {
    assert.match(build().text, /Paid towards it: nothing/);
  });

  test("a run of missed statements is counted", () => {
    const { text, html } = build({ standing: { missedCount: 3 } });
    assert.match(text, /3rd statement in a row/);
    assert.match(html, /3rd statement in a row/);
  });

  test("a single miss is not dressed up as a run", () => {
    assert.doesNotMatch(build().text, /in a row/);
  });

  test("the count reads as English, including the ones that break the rule", () => {
    // 3th was what the first version of this said.
    assert.match(build({ standing: { missedCount: 2 } }).text, /2nd statement/);
    assert.match(build({ standing: { missedCount: 4 } }).text, /4th statement/);
    // 11, 12 and 13 do not follow their last digit.
    assert.match(build({ standing: { missedCount: 11 } }).text, /11th statement/);
    assert.match(build({ standing: { missedCount: 21 } }).text, /21st statement/);
  });

  test("the link goes to the page that can fix it", () => {
    const { text, html } = build();
    assert.match(text, /https:\/\/cashflow\.example\/credit/);
    assert.match(html, /href="https:\/\/cashflow\.example\/credit"/);
  });
});

describe("the reminder that goes before the date", () => {
  const soon = (over = {}) =>
    minimumDueSoonEmail({
      facility: { label: "Everyday card" },
      statement: {
        cycle: "2026-06", closedOn: "2026-06-30", dueOn: "2026-07-21",
        balance: 4100, interest: 100, minimumDue: 205, paidTowards: 0,
        ...(over.statement || {})
      },
      standing: { balance: 4202.5, monthlyInterest: 105.06, ...(over.standing || {}) },
      fmt,
      url: "https://cashflow.example/credit"
    });

  test("leads with what is owed and when, not with what went wrong", () => {
    const { subject } = soon();
    assert.match(subject, /KSh 205\.00 due on Everyday card by Jul 21, 2026/);
    assert.doesNotMatch(subject, /missed/i);
  });

  test("says it is due, never that it was not met", () => {
    // Nothing has gone wrong yet, and an email implying otherwise about
    // somebody's own money would be its own small harm.
    const { text, html } = soon();
    assert.match(text, /is due on Jul 21, 2026/);
    assert.doesNotMatch(text, /has not been met|missed/i);
    assert.doesNotMatch(html, /has not been met|missed/i);
  });

  test("offers the way out of the interest as well as the minimum", () => {
    const { text } = soon();
    assert.match(text, /Clearing the whole KSh 4,202\.50 stops the interest/);
    assert.match(text, /KSh 105\.06 next month/);
  });

  test("a part payment changes what it asks for", () => {
    const { subject, text } = soon({ statement: { paidTowards: 80 } });
    assert.match(subject, /KSh 125\.00 due/);
    assert.match(text, /Already paid: KSh 80\.00 — KSh 125\.00 to go/);
  });

  test("the card's name is escaped here too", () => {
    const { html } = minimumDueSoonEmail({
      facility: { label: '<img src=x onerror="alert(1)">' },
      statement: {
        closedOn: "2026-06-30", dueOn: "2026-07-21",
        balance: 100, minimumDue: 5, paidTowards: 0
      },
      standing: { balance: 100, monthlyInterest: 2 },
      fmt,
      url: "https://cashflow.example/credit"
    });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });
});

describe("what the holder typed", () => {
  test("is escaped before it reaches the HTML", () => {
    const { html } = build({ facility: { label: '<script>alert("x")</script>' } });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  });

  test("and is left alone in the plain text, which renders nothing", () => {
    const { text } = build({ facility: { label: "<b>Card</b>" } });
    assert.match(text, /<b>Card<\/b>/);
  });
});
