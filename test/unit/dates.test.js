import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatDate, monthStart, nextOccurrence, toISODate } from "../../utils/dates.js";

describe("toISODate", () => {
  test("formats a Date in local time", () => {
    assert.equal(toISODate(new Date(2026, 0, 5)), "2026-01-05");
  });

  test("pads single digits", () => {
    assert.equal(toISODate(new Date(2026, 8, 9)), "2026-09-09");
  });

  test("does not slip a day near midnight, as toISOString would", () => {
    assert.equal(toISODate(new Date(2026, 2, 1, 23, 30)), "2026-03-01");
  });

  test("a date-only string is already the day it names", () => {
    // new Date("2026-01-01") is UTC midnight, which is still 2025-12-31 in
    // every zone behind UTC. Reading local components off that moved the day
    // backwards and started loans a month early. The string needs no parsing.
    assert.equal(toISODate("2026-01-01"), "2026-01-01");
    assert.equal(toISODate("2026-12-31"), "2026-12-31");
  });

  test("a string carrying a time is still converted as an instant", () => {
    // Only the date-only form short-circuits: this one names a moment, and
    // which day it falls on genuinely depends on where you are reading it.
    const midday = new Date(2026, 5, 15, 12, 0);
    assert.equal(toISODate(midday.toISOString()), "2026-06-15");
  });

  test("returns null for nothing", () => {
    assert.equal(toISODate(null), null);
    assert.equal(toISODate(undefined), null);
  });
});

describe("formatDate", () => {
  test("shows the day a date-only string names", () => {
    // What reaches this is often a string rather than a Date — an estimated
    // delivery, a recurring rule's next run, a date off a form. Read as UTC
    // midnight they would all display a day early behind UTC, and the 1st
    // would show the previous month with it.
    assert.equal(formatDate("2026-08-08"), "Aug 8, 2026");
    assert.equal(formatDate("2026-08-01"), "Aug 1, 2026");
  });

  test("formats a Date as the day it is locally", () => {
    assert.equal(formatDate(new Date(2026, 7, 8)), "Aug 8, 2026");
  });

  test("returns null for nothing, rather than the epoch", () => {
    // Date reads null as 0, so the unguarded version of this answered
    // "Jan 1, 1970" — a date, confidently wrong, where there was none.
    assert.equal(formatDate(null), null);
    assert.equal(formatDate(undefined), null);
    assert.equal(formatDate(""), null);
  });
});

describe("monthStart", () => {
  test("is the first of the given month", () => {
    assert.equal(monthStart(new Date(2026, 6, 23)), "2026-07-01");
  });
});

describe("nextOccurrence", () => {
  test("weekly steps seven days", () => {
    assert.equal(nextOccurrence("2026-04-01", "weekly"), "2026-04-08");
  });

  test("monthly steps one month", () => {
    assert.equal(nextOccurrence("2026-04-15", "monthly"), "2026-05-15");
  });

  test("yearly steps one year", () => {
    assert.equal(nextOccurrence("2026-04-15", "yearly"), "2027-04-15");
  });

  test("a month-end date clamps instead of spilling into the next month", () => {
    // The classic bug: Jan 31 + 1 month must not become March 3.
    assert.equal(nextOccurrence("2026-01-31", "monthly"), "2026-02-28");
  });

  test("clamps to the right length in a leap year", () => {
    assert.equal(nextOccurrence("2024-01-31", "monthly"), "2024-02-29");
  });

  test("a 31st rolls through a 30-day month and back", () => {
    assert.equal(nextOccurrence("2026-03-31", "monthly"), "2026-04-30");
  });

  test("a yearly leap-day rule lands on the 28th in common years", () => {
    assert.equal(nextOccurrence("2024-02-29", "yearly"), "2025-02-28");
  });

  test("crosses the year boundary", () => {
    assert.equal(nextOccurrence("2026-12-15", "monthly"), "2027-01-15");
    assert.equal(nextOccurrence("2026-12-29", "weekly"), "2027-01-05");
  });

  test("an unknown frequency is treated as monthly", () => {
    assert.equal(nextOccurrence("2026-04-15", "fortnightly"), "2026-05-15");
  });
});
