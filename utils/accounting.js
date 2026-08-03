// The accountant's judgement, as code.
//
// Everything here is a pure function over the business's own rows. That is
// deliberate: an AI writes the covering note for these findings, but it never
// produces a figure. A tax number that came out of a language model would be
// unauditable and occasionally wrong, and neither is acceptable for money the
// owner has to remit. The model explains what this file computes — nothing more.

import { toISODate } from "./dates.js";

// A duplicate has to be close in time as well as identical in amount.
const DUPLICATE_WINDOW_DAYS = 4;
// Below this, a repeated round number is usually just a repeated round number.
const DUPLICATE_MIN_AMOUNT = 500;
// A category has to be spending real money before a spike is worth raising.
const SPIKE_MIN_AMOUNT = 5000;
const SPIKE_MULTIPLE = 2;

export const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function daysBetween(a, b) {
  const start = Date.parse(`${toISODate(a)}T00:00:00`);
  const end = Date.parse(`${toISODate(b)}T00:00:00`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 86400000);
}

const money = (n) => Number(n || 0);

// How amounts are written into a finding. The caller injects the business's
// real currency formatter; the default keeps this module free of any currency
// knowledge, which is what lets it stay pure and testable.
const plain = (n) => money(n).toFixed(2);

// --- Tax ---

// Taxable profit follows the income statement, which is accrual: stock that has
// not sold yet is an asset, not a cost. The cash figure would tax the business
// on money it spent filling its own shelves.
export function taxPosition({
  accrualProfit,
  rate,
  payrollDeductions = 0,
  setAside = 0
}) {
  const taxableProfit = Math.max(money(accrualProfit), 0);
  const incomeTax = taxableProfit * (money(rate) / 100);
  const remittances = money(payrollDeductions);
  const totalOwed = incomeTax + remittances;
  const held = money(setAside);
  const shortfall = Math.max(totalOwed - held, 0);

  return {
    taxableProfit,
    rate: money(rate),
    incomeTax,
    remittances,
    totalOwed,
    setAside: held,
    shortfall,
    surplus: Math.max(held - totalOwed, 0),
    coverage: totalOwed > 0 ? Math.min((held / totalOwed) * 100, 100) : 100,
    // What the old cash-basis calculation would have said, so the difference
    // can be explained rather than just appearing.
    effectiveRate: taxableProfit > 0 ? (totalOwed / taxableProfit) * 100 : 0
  };
}

// --- The review ---

function finding(code, severity, title, detail, extra = {}) {
  return { code, severity, title, detail, ...extra };
}

// Entries nobody has told the books what they are.
function uncategorised(transactions, fmt) {
  const loose = transactions.filter((t) => {
    const c = (t.category || "").trim().toLowerCase();
    return c === "" || c === "uncategorized" || c === "uncategorised" || c === "other";
  });
  if (loose.length === 0) return [];

  const total = loose.reduce((s, t) => s + money(t.amount), 0);
  return [
    finding(
      "uncategorised",
      "high",
      `${loose.length} entr${loose.length === 1 ? "y has" : "ies have"} no real category`,
      `${loose.length} entries totalling ${fmt(total)} are sitting in a catch-all. ` +
        `They land in the wrong place on the income statement and, if any of them are ` +
        `deductible costs, they are inflating the tax bill.`,
      { subjects: loose.map((t) => t.id), amount: total, action: "categorise" }
    )
  ];
}

// Same money, same category, days apart — usually one payment entered twice.
// Reported as clusters, not pairs. Four identical entries in a week are one
// thing to look at; as pairs they would be six findings burying everything else.
function duplicates(transactions, fmt) {
  const groups = new Map();
  for (const t of transactions) {
    const amount = money(t.amount);
    if (amount < DUPLICATE_MIN_AMOUNT) continue;
    const key = `${t.kind}|${t.category || ""}|${amount}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const clusters = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    // Sort on the ISO form: the database hands back Date objects, and
    // stringifying one gives "Sun Jun 28 2026…", which sorts by weekday name.
    const sorted = [...rows].sort((a, b) =>
      toISODate(a.occurred_on).localeCompare(toISODate(b.occurred_on))
    );

    let run = [sorted[0]];
    for (let i = 1; i < sorted.length; i += 1) {
      // Distance, not direction — a signed gap would let anything dated earlier
      // slip through the window.
      const gap = daysBetween(run[run.length - 1].occurred_on, sorted[i].occurred_on);
      if (gap !== null && Math.abs(gap) <= DUPLICATE_WINDOW_DAYS) {
        run.push(sorted[i]);
      } else {
        if (run.length >= 2) clusters.push(run);
        run = [sorted[i]];
      }
    }
    if (run.length >= 2) clusters.push(run);
  }

  return clusters.map((run) => {
    const first = run[0];
    const last = run[run.length - 1];
    const amount = money(first.amount);
    const overstating = first.kind === "expense" ? "costs" : "revenue";
    const span =
      toISODate(first.occurred_on) === toISODate(last.occurred_on)
        ? `all on ${toISODate(first.occurred_on)}`
        : `between ${toISODate(first.occurred_on)} and ${toISODate(last.occurred_on)}`;

    return finding(
      "duplicate",
      "high",
      run.length === 2
        ? `Possible duplicate: ${first.category} ${fmt(amount)}`
        : `${run.length} identical ${first.category} entries of ${fmt(amount)}`,
      `${run.length} ${first.kind} entries of ${fmt(amount)} under ${first.category}, ` +
        `${span}. If that was one payment, ${run.length - 1} of them ` +
        `${run.length === 2 ? "is" : "are"} overstating ${overstating} by ` +
        `${fmt(amount * (run.length - 1))}.`,
      { subjects: run.map((t) => t.id), amount: amount * (run.length - 1) }
    );
  });
}

function overdue(documents, kind, today, fmt) {
  return documents
    .filter((d) => d.status === "unpaid" && d.due_on && daysBetween(d.due_on, today) > 0)
    .map((d) => {
      const late = daysBetween(d.due_on, today);
      const owed = kind === "invoice";
      return finding(
        owed ? "overdue-receivable" : "overdue-payable",
        late > 30 ? "high" : "medium",
        owed
          ? `${d.customer || "A customer"} is ${late} days late paying ${fmt(d.amount)}`
          : `${d.vendor || "A bill"} is ${late} days overdue — ${fmt(d.amount)}`,
        owed
          ? `Invoice #${d.id} was due ${toISODate(d.due_on)}. It is counted in revenue and in ` +
            `taxable profit, so the tax on it is owed whether or not the money arrives.`
          : `Bill #${d.id} was due ${toISODate(d.due_on)}. Late payment can cost more than ` +
            `the bill, and it is already sitting in payables.`,
        { subjects: [d.id], amount: money(d.amount) }
      );
    });
}

// Stock the business would lose money selling.
function pricing(products, fmt) {
  return products
    .filter((p) => money(p.sale_price) <= money(p.unit_cost) && money(p.unit_cost) > 0)
    .map((p) =>
      finding(
        "priced-at-cost",
        money(p.sale_price) < money(p.unit_cost) ? "high" : "medium",
        `${p.name} sells for ${money(p.sale_price) < money(p.unit_cost) ? "less than" : "exactly"} what it costs`,
        `Cost ${fmt(p.unit_cost)}, price ${fmt(p.sale_price)}. ` +
          `Every unit sold earns ${fmt(money(p.sale_price) - money(p.unit_cost))}. ` +
          `Stock received from a supplier is priced at cost until somebody sets a margin.`,
        { subjects: [p.id] }
      )
    );
}

// Sales that cost more than they brought in.
function lossMakingSales(sales, fmt) {
  const losses = sales.filter((s) => money(s.cost_total) > money(s.total));
  if (losses.length === 0) return [];
  const lost = losses.reduce((sum, s) => sum + (money(s.cost_total) - money(s.total)), 0);
  return [
    finding(
      "sold-at-a-loss",
      "medium",
      `${losses.length} sale${losses.length === 1 ? "" : "s"} cost more than they earned`,
      `Together they gave up ${fmt(lost)} in margin. Worth checking whether the ` +
        `prices are wrong or the stock was carried at the wrong cost.`,
      { subjects: losses.map((s) => s.id), amount: lost }
    )
  ];
}

// A month with nothing in it usually means the books were not kept, not that
// the business stopped trading.
function quietMonths(trend) {
  return trend
    .filter((m) => money(m.revenue) === 0 && money(m.expenses) === 0)
    .map((m) =>
      finding(
        "quiet-month",
        "medium",
        `Nothing was recorded in ${m.month}`,
        `No income and no expenses for the whole month. If the business was trading, ` +
          `that month's records are missing and every total is understated.`,
        { subjects: [m.month] }
      )
    );
}

// A category well above its own recent average.
function spikes(transactions, today, fmt) {
  const thisMonth = toISODate(today).slice(0, 7);
  const current = new Map();
  const history = new Map();

  for (const t of transactions) {
    if (t.kind !== "expense") continue;
    const month = toISODate(t.occurred_on).slice(0, 7);
    const bucket = month === thisMonth ? current : history;
    const key = t.category || "Uncategorised";
    if (!bucket.has(key)) bucket.set(key, new Map());
    const months = bucket.get(key);
    months.set(month, (months.get(month) || 0) + money(t.amount));
  }

  const out = [];
  for (const [category, months] of current) {
    const spent = [...months.values()][0] || 0;
    const past = [...(history.get(category)?.values() || [])];
    if (past.length < 2 || spent < SPIKE_MIN_AMOUNT) continue;
    const average = past.reduce((s, n) => s + n, 0) / past.length;
    if (average > 0 && spent >= average * SPIKE_MULTIPLE) {
      out.push(
        finding(
          "spike",
          "medium",
          `${category} is ${(spent / average).toFixed(1)}× its usual month`,
          `${fmt(spent)} so far against a ${fmt(average)} average over the ` +
            `previous ${past.length} months. Either something changed or something was ` +
            `posted to the wrong category.`,
          { subjects: [category], amount: spent }
        )
      );
    }
  }
  return out;
}

function taxFindings(tax, stock, fmt) {
  const out = [];

  if (tax.shortfall > 0) {
    out.push(
      finding(
        "tax-shortfall",
        tax.coverage < 50 ? "high" : "medium",
        `${fmt(tax.shortfall)} of tax is not set aside`,
        `Income tax of ${fmt(tax.incomeTax)} at ${tax.rate}% plus ` +
          `${fmt(tax.remittances)} of payroll deductions comes to ` +
          `${fmt(tax.totalOwed)}. ${fmt(tax.setAside)} is held, which covers ` +
          `${tax.coverage.toFixed(0)}%.`,
        { amount: tax.shortfall, action: "set-aside" }
      )
    );
  }

  // Stock with no purchase behind it means the cost of sales is understated,
  // which overstates profit — and therefore the tax owed on it.
  if (stock?.unpurchasedStock) {
    out.push(
      finding(
        "unpurchased-stock",
        "medium",
        "Some stock was entered by hand rather than bought",
        `Closing stock of ${fmt(stock.closingInventory)} exceeds the ` +
          `${fmt(stock.purchases)} ever spent on stock, so part of the shelves ` +
          `has no purchase behind it. Cost of sales is understated and profit — and the tax ` +
          `on it — reads high.`
      )
    );
  }

  return out;
}

// The whole close, in one pass.
export function reviewLedger({
  transactions = [],
  invoices = [],
  bills = [],
  products = [],
  sales = [],
  trend = [],
  tax,
  stock,
  today,
  fmt = plain
}) {
  const reference = today || toISODate(new Date());

  const findings = [
    ...uncategorised(transactions, fmt),
    ...duplicates(transactions, fmt),
    ...overdue(invoices, "invoice", reference, fmt),
    ...overdue(bills, "bill", reference, fmt),
    ...pricing(products, fmt),
    ...lossMakingSales(sales, fmt),
    ...quietMonths(trend),
    ...spikes(transactions, reference, fmt),
    ...(tax ? taxFindings(tax, stock, fmt) : [])
  ];

  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      money(b.amount) - money(a.amount)
  );

  return {
    findings,
    counts: {
      total: findings.length,
      high: findings.filter((f) => f.severity === "high").length,
      medium: findings.filter((f) => f.severity === "medium").length,
      low: findings.filter((f) => f.severity === "low").length
    },
    clean: findings.length === 0
  };
}
