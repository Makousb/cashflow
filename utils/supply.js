// Supply chain maths: the order lifecycle, delivery estimates, and the
// performance numbers behind the reports page. Pure functions — everything
// takes plain rows and returns plain objects.

import { toISODate } from "./dates.js";

// The happy path an order walks, in order.
export const ORDER_FLOW = ["placed", "confirmed", "shipped", "delivered", "received"];

// Statuses that mean the order is still moving.
export const OPEN_STATUSES = ["placed", "confirmed", "shipped", "delivered"];

// Statuses that ended the order without goods changing hands.
export const CLOSED_STATUSES = ["cancelled", "declined"];

export const STATUS_META = {
  placed: {
    label: "Placed",
    icon: "📝",
    badge: "badge-warn",
    blurb: "Waiting for the supplier to confirm"
  },
  confirmed: {
    label: "Confirmed",
    icon: "✅",
    badge: "badge-warn",
    blurb: "Accepted — the supplier has committed to a date"
  },
  shipped: {
    label: "Shipped",
    icon: "🚚",
    badge: "badge-warn",
    blurb: "On the way to the buyer"
  },
  delivered: {
    label: "Delivered",
    icon: "📦",
    badge: "badge-done",
    blurb: "Arrived — waiting for the buyer to receive it into stock"
  },
  received: {
    label: "Received",
    icon: "🏬",
    badge: "badge-done",
    blurb: "Stocked and billed"
  },
  cancelled: {
    label: "Cancelled",
    icon: "🚫",
    badge: "badge-danger",
    blurb: "Cancelled by the buyer"
  },
  declined: {
    label: "Declined",
    icon: "🚫",
    badge: "badge-danger",
    blurb: "Declined by the supplier"
  }
};

export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.placed;
}

export function isOpen(order) {
  return OPEN_STATUSES.includes(order.status);
}

export function addDays(isoDate, days) {
  const [year, month, day] = String(isoDate).slice(0, 10).split("-").map(Number);
  return toISODate(new Date(year, month - 1, day + Number(days || 0)));
}

// Whole calendar days from a to b (negative if b is earlier).
export function daysBetween(a, b) {
  if (!a || !b) return null;
  const start = Date.parse(`${toISODate(a)}T00:00:00`);
  const end = Date.parse(`${toISODate(b)}T00:00:00`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 86400000);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

// How long an order actually took to arrive, in days.
export function transitDays(order) {
  return order.delivered_at ? daysBetween(order.placed_on, order.delivered_at) : null;
}

// Estimated delivery date. A supplier's stated lead time is only a starting
// point — once there is history with them, what they actually did carries the
// estimate, because that is the number the buyer plans around.
export function estimateEta({ leadTimeDays = 3, samples = [], from }) {
  const start = from || toISODate(new Date());
  const lead = Math.max(Math.round(Number(leadTimeDays) || 0), 1);
  const history = samples
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);

  let days = lead;
  let basis = `${lead}-day stated lead time`;

  if (history.length >= 3) {
    days = Math.max(Math.round(median(history)), 1);
    basis = `median of the last ${history.length} deliveries from this supplier`;
  } else if (history.length > 0) {
    const average = history.reduce((sum, n) => sum + n, 0) / history.length;
    days = Math.max(Math.round((lead + average) / 2), 1);
    basis =
      `stated lead time blended with ` +
      `${history.length} past ${history.length === 1 ? "delivery" : "deliveries"}`;
  }

  return { days, date: addDays(start, days), basis, samples: history.length };
}

// The date the buyer is watching: what the supplier committed to, or failing
// that the estimate made when the order was placed.
export function targetDate(order) {
  return order.promised_on || order.expected_on || null;
}

// Days late (positive) or early (negative) against that date. Open orders are
// measured against today, finished ones against when they actually arrived.
export function lateness(order, referenceDate) {
  const target = targetDate(order);
  if (!target) return null;
  const reference = order.delivered_at || referenceDate || new Date();
  return daysBetween(target, reference);
}

export function isLate(order, referenceDate) {
  if (!isOpen(order)) return false;
  const late = lateness(order, referenceDate);
  return late !== null && late > 0;
}

export function deliveredOnTime(order) {
  if (!order.delivered_at) return null;
  const late = lateness(order);
  return late === null ? null : late <= 0;
}

// The step-by-step trail shown on an order, with the timestamp of each stage
// that has happened so far.
export function timeline(order) {
  const stamps = {
    placed: order.placed_on,
    confirmed: order.confirmed_at,
    shipped: order.shipped_at,
    delivered: order.delivered_at,
    received: order.received_at
  };

  const reachedIndex = ORDER_FLOW.indexOf(order.status);

  return ORDER_FLOW.map((status, index) => ({
    status,
    ...statusMeta(status),
    at: stamps[status] || null,
    done: Boolean(stamps[status]) || (reachedIndex >= 0 && index <= reachedIndex),
    current: status === order.status
  }));
}

export function progressPercent(order) {
  if (CLOSED_STATUSES.includes(order.status)) return 100;
  const index = ORDER_FLOW.indexOf(order.status);
  if (index < 0) return 0;
  return Math.round(((index + 1) / ORDER_FLOW.length) * 100);
}

// Headline numbers for a set of orders seen from one side of the trade.
export function summarizeOrders(orders, referenceDate) {
  const value = (list) => list.reduce((sum, o) => sum + Number(o.total || 0), 0);

  const open = orders.filter(isOpen);
  const inTransit = orders.filter((o) => ["shipped", "delivered"].includes(o.status));
  const settled = orders.filter((o) => o.status === "received");
  const rejected = orders.filter((o) => CLOSED_STATUSES.includes(o.status));
  const late = open.filter((o) => isLate(o, referenceDate));
  const completed = orders.filter((o) => ["delivered", "received"].includes(o.status));

  const onTimeJudged = completed
    .map(deliveredOnTime)
    .filter((v) => v !== null);
  const transits = completed.map(transitDays).filter((n) => n !== null);

  const byStatus = {};
  for (const order of orders) {
    byStatus[order.status] = (byStatus[order.status] || 0) + 1;
  }

  return {
    count: orders.length,
    openCount: open.length,
    openValue: value(open),
    inTransitCount: inTransit.length,
    settledCount: settled.length,
    settledValue: value(settled),
    totalValue: value(orders.filter((o) => !CLOSED_STATUSES.includes(o.status))),
    lateCount: late.length,
    rejectedCount: rejected.length,
    onTimeRate: onTimeJudged.length
      ? (onTimeJudged.filter(Boolean).length / onTimeJudged.length) * 100
      : null,
    fulfillmentRate: completed.length + rejected.length
      ? (completed.length / (completed.length + rejected.length)) * 100
      : null,
    avgTransitDays: transits.length
      ? transits.reduce((sum, n) => sum + n, 0) / transits.length
      : null,
    byStatus
  };
}

// One row per trading counterpart. `side` picks which end of the order the
// counterpart sits on: "supplier" for the buyer's view, "buyer" for the
// supplier's view.
export function partnerScorecards(orders, side = "supplier") {
  const idKey = side === "supplier" ? "supplier_business_id" : "buyer_business_id";
  const nameKey = side === "supplier" ? "supplier_name" : "buyer_name";
  const groups = new Map();

  for (const order of orders) {
    const id = order[idKey];
    if (!groups.has(id)) {
      groups.set(id, { id, name: order[nameKey] || `Business #${id}`, orders: [] });
    }
    groups.get(id).orders.push(order);
  }

  return [...groups.values()]
    .map((group) => ({
      id: group.id,
      name: group.name,
      ...summarizeOrders(group.orders)
    }))
    .sort((a, b) => b.totalValue - a.totalValue);
}

// Order count and value per month, oldest first, for the trend chart.
export function monthlySeries(orders, months = 6) {
  const buckets = new Map();
  const now = new Date();

  for (let i = months - 1; i >= 0; i -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = toISODate(date).slice(0, 7);
    buckets.set(key, { month: key, count: 0, value: 0 });
  }

  for (const order of orders) {
    if (CLOSED_STATUSES.includes(order.status)) continue;
    const key = toISODate(order.placed_on).slice(0, 7);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.count += 1;
    bucket.value += Number(order.total || 0);
  }

  return [...buckets.values()];
}

// What is being ordered most, by units and by spend.
export function topItems(items, limit = 8) {
  const groups = new Map();

  for (const item of items) {
    const key = (item.name || "").toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, { name: item.name, quantity: 0, value: 0, orders: 0 });
    }
    const group = groups.get(key);
    group.quantity += Number(item.quantity || 0);
    group.value += Number(item.quantity || 0) * Number(item.unit_price || 0);
    group.orders += 1;
  }

  return [...groups.values()]
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}
