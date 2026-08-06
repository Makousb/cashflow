// First day of the given date's month as YYYY-MM-01 (matches budgets.month).
export function monthStart(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-01`;
}

export function monthLabel(date = new Date()) {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// A Date to read local components off. The case that matters is a bare
// YYYY-MM-DD: it names a calendar day, and the Date constructor reads that
// exact form as UTC midnight — which is the previous day everywhere behind
// UTC, so every getter afterwards answers for the wrong date. Building it from
// the parts keeps the day it names. Anything else is a real instant and is
// left to Date, which is what it is for.
export function toLocalDate(value) {
  if (value instanceof Date) {
    return value;
  }

  const parts = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (parts) {
    return new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  }

  return new Date(value);
}

// Local-timezone YYYY-MM-DD (toISOString would shift the day near midnight).
export function toISODate(value) {
  if (!value) {
    return null;
  }

  // A bare YYYY-MM-DD is a calendar day, not an instant, and is already the
  // answer. Handing it to Date would read it as UTC midnight — which is the day
  // before, everywhere behind UTC — and then take local components back off it.
  // Anything carrying a time stays a real instant and is converted as one.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const date = value instanceof Date ? value : new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function today() {
  return toISODate(new Date());
}

// Add n months, clamping the day to the target month's length so
// "Jan 31 + 1 month" lands on Feb 28/29 rather than spilling into March.
function addMonthsClamped(year, monthIndex, day, n) {
  const firstOfTarget = new Date(year, monthIndex + n, 1);
  const lastDay = new Date(
    firstOfTarget.getFullYear(),
    firstOfTarget.getMonth() + 1,
    0
  ).getDate();
  return new Date(
    firstOfTarget.getFullYear(),
    firstOfTarget.getMonth(),
    Math.min(day, lastDay)
  );
}

// n days on from a calendar day, as YYYY-MM-DD. Day arithmetic needs no
// clamping — every month has all of its own days — so this is the plain step
// that addMonths cannot be.
export function addDays(value, n) {
  const date = toLocalDate(value);
  return toISODate(
    new Date(date.getFullYear(), date.getMonth(), date.getDate() + Number(n || 0))
  );
}

// The YYYY-MM a day falls in.
export function monthKey(value) {
  return toISODate(value).slice(0, 7);
}

// Chronological YYYY-MM keys from one day's month through another's, both ends
// included. What anything accruing month by month walks over.
export function monthsBetween(startIso, endIso) {
  const keys = [];
  let [year, month] = monthKey(startIso).split("-").map(Number);
  const [endYear, endMonth] = monthKey(endIso).split("-").map(Number);
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      year += 1;
      month = 1;
    }
  }
  return keys;
}

// The same clamped step, for callers holding a date rather than its parts.
export function addMonths(value, n) {
  const date = toLocalDate(value);
  return addMonthsClamped(date.getFullYear(), date.getMonth(), date.getDate(), n);
}

// Next occurrence of a recurring date, as YYYY-MM-DD.
export function nextOccurrence(isoDate, frequency) {
  const [year, month, day] = isoDate.slice(0, 10).split("-").map(Number);
  let result;
  if (frequency === "weekly") {
    result = new Date(year, month - 1, day + 7);
  } else if (frequency === "yearly") {
    result = addMonthsClamped(year, month - 1, day, 12);
  } else {
    result = addMonthsClamped(year, month - 1, day, 1);
  }
  return toISODate(result);
}

export function formatDate(value) {
  // Nothing in, nothing out — as toISODate does. Date reads null as the epoch,
  // so without this a missing date renders as a confident "Jan 1, 1970". Every
  // caller today checks the value first and none of them would have seen it;
  // the next one to forget would, and would have no reason to suspect this.
  if (!value) {
    return null;
  }

  // Plenty of what reaches here is a date-only string rather than a Date: an
  // estimated delivery from addDays, a recurring rule's next_run_iso, a date
  // straight off a form. All of them are days, and none should be shown as the
  // day before to anyone reading from behind UTC.
  const date = toLocalDate(value);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}
