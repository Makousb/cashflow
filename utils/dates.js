// First day of the given date's month as YYYY-MM-01 (matches budgets.month).
export function monthStart(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-01`;
}

export function monthLabel(date = new Date()) {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
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
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}
