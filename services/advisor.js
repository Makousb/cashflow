import { config } from "../config/env.js";

// The business advisor. When an AI provider is configured (AI_API_KEY +
// AI_BASE_URL + AI_MODEL) it answers conversationally, grounded in the
// business's figures. Otherwise it falls back to instant, data-driven insights
// computed here. The integration is provider-agnostic — it speaks the standard
// chat-completions request shape, so nothing about a specific vendor is baked in.

export function aiEnabled() {
  return Boolean(config.ai.apiKey && config.ai.baseUrl && config.ai.model);
}

function monthName(ym) {
  if (!ym) return "";
  const [year, month] = ym.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric"
  });
}

// A full plain-text snapshot — the three statements plus the monthly trend —
// used to ground the advisor's answers.
function snapshotText(d, fmt) {
  const s = d.statements;
  const lines = [
    `Business: ${d.name}${d.industry ? ` (${d.industry})` : ""}`,
    "",
    "INCOME STATEMENT (to date):",
    `  Revenue: ${fmt(s.income.revenue)}`,
    `  Cost of goods sold: ${fmt(s.income.cogs)}`,
    `  Gross profit: ${fmt(s.income.grossProfit)}`,
    ...s.income.operating.map((e) => `  ${e.category}: ${fmt(e.total)}`),
    `  Total operating expenses: ${fmt(s.income.operatingTotal)}`,
    `  Net profit: ${fmt(s.income.netProfit)} (${d.margin.toFixed(0)}% margin)`,
    "",
    "BALANCE SHEET (as of today):",
    `  Cash: ${fmt(s.balance.assets.cash)}`,
    `  Accounts receivable: ${fmt(s.balance.assets.receivable)}`,
    `  Inventory: ${fmt(s.balance.assets.inventory)}`,
    `  Total assets: ${fmt(s.balance.assets.total)}`,
    `  Accounts payable (liabilities): ${fmt(s.balance.liabilities.total)}`,
    `  Owner's equity: ${fmt(s.balance.equity)}`,
    "",
    `CASH FLOW: net operating cash ${fmt(s.cashFlow.netOperating)}`,
    "",
    "MONTHLY TREND (revenue / expenses / net):",
    ...d.trend.map(
      (t) => `  ${monthName(t.month)}: ${fmt(t.revenue)} / ${fmt(t.expenses)} / ${fmt(t.net)}`
    ),
    "",
    "OTHER:",
    `  Inventory items low or out of stock: ${d.lowStockCount}`,
    `  Employees: ${d.employeeCount}, monthly payroll ${fmt(d.monthlyPayroll)}`,
    `  Estimated tax owed: ${fmt(d.estimatedTax)} (income tax rate ${d.taxRate}%)`
  ];
  return lines.join("\n");
}

async function llmAnswer(question, d, fmt) {
  const system =
    `You are the built-in financial advisor for ${d.name}, a small business, ` +
    `inside their bookkeeping app. Answer the owner's question in a concise, ` +
    `practical, encouraging way, using the figures below and citing specific ` +
    `numbers. If the data doesn't cover the question, say so briefly. Do not ` +
    `mention what model or service you are.\n\nCurrent figures:\n` +
    snapshotText(d, fmt);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(`${config.ai.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.ai.apiKey}`
      },
      body: JSON.stringify({
        model: config.ai.model,
        max_tokens: 500,
        temperature: 0.3,
        messages: [
          { role: "system", content: system },
          { role: "user", content: question }
        ]
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`provider responded ${res.status}`);
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("empty response");
    return { text, mode: "ai" };
  } catch (error) {
    console.warn(`Advisor: AI provider unavailable (${error.message})`);
    return { text: heuristicAnswer(question, d, fmt), mode: "offline" };
  } finally {
    clearTimeout(timer);
  }
}

// Data-driven answers without an LLM: match the question's intent to the most
// relevant figures.
export function heuristicAnswer(question, d, fmt) {
  const q = question.toLowerCase();
  const has = (...words) => words.some((w) => q.includes(w));
  const top = d.topExpenses[0];
  const s = d.statements;

  if (has("trend", "grow", "growth", "last month", "this month", "compare",
          "improving", "momentum", "over time", "month on month", "monthly", "sales going")) {
    if (d.trend.length >= 2 && d.thisMonth && d.lastMonth) {
      const rg = d.lastMonth.revenue > 0
        ? ((d.thisMonth.revenue - d.lastMonth.revenue) / d.lastMonth.revenue) * 100
        : 0;
      const series = d.trend.map((t) => `${monthName(t.month)} ${fmt(t.net)}`).join(" → ");
      return `Revenue is ${rg >= 0 ? "up" : "down"} ${Math.abs(rg).toFixed(0)}% ` +
        `month-on-month — ${fmt(d.lastMonth.revenue)} in ${monthName(d.lastMonth.month)} ` +
        `to ${fmt(d.thisMonth.revenue)} in ${monthName(d.thisMonth.month)}. ` +
        `Net profit by month: ${series}.`;
    }
    return `There's only ${d.trend.length} month of data so far — keep recording ` +
      `and I'll show you the trend.`;
  }
  if (has("balance sheet", "assets", "liabilit", "equity", "net worth", "worth", "own")) {
    return `Balance sheet: assets ${fmt(s.balance.assets.total)} ` +
      `(cash ${fmt(s.balance.assets.cash)} + receivables ${fmt(s.balance.assets.receivable)} ` +
      `+ inventory ${fmt(s.balance.assets.inventory)}), liabilities ` +
      `${fmt(s.balance.liabilities.total)}, so owner's equity is ${fmt(s.balance.equity)}.`;
  }
  if (has("profit", "margin", "profitable", "loss", "making money", "net", "gross")) {
    let text = `${d.netProfit >= 0 ? "You're profitable" : "You're running at a loss"}: ` +
      `revenue ${fmt(s.income.revenue)} − COGS ${fmt(s.income.cogs)} = gross profit ` +
      `${fmt(s.income.grossProfit)}; after ${fmt(s.income.operatingTotal)} operating ` +
      `expenses, net profit is ${fmt(s.income.netProfit)} (${d.margin.toFixed(0)}% margin). ` +
      `Biggest cost: ${top ? `${top.category} at ${fmt(top.total)}` : "not yet recorded"}.`;
    if (d.thisMonth && d.lastMonth) {
      text += ` This month's net ${fmt(d.thisMonth.net)} is ` +
        `${d.thisMonth.net >= d.lastMonth.net ? "up from" : "down from"} ` +
        `${fmt(d.lastMonth.net)} last month.`;
    }
    return text;
  }
  if (has("cash", "liquid", "bank", "runway", "afford")) {
    return `Cash on hand is ${fmt(d.cash)}. Customers owe you ${fmt(d.receivable)} ` +
      `and you owe ${fmt(d.payable)} in bills. Collecting receivables would lift ` +
      `cash to ${fmt(d.cash + d.receivable)}.`;
  }
  if (has("cut", "reduce", "save", "spend", "expense", "trim")) {
    const list = d.topExpenses.slice(0, 3).map((e) => `${e.category} (${fmt(e.total)})`).join(", ");
    return `Your largest expenses are ${list || "not yet recorded"}. Trimming the ` +
      `most flexible of these — and cancelling anything underused — is the quickest ` +
      `way to lift your ${fmt(d.netProfit)} net profit.`;
  }
  if (has("tax", "kra", "paye")) {
    return `Estimated tax owed is ${fmt(d.estimatedTax)} at a ${d.taxRate}% income-tax ` +
      `rate, including payroll deductions to remit. Set some of your ${fmt(d.cash)} cash ` +
      `aside so it's ready at filing.`;
  }
  if (has("owes me", "owe me", "who owe", "owed", "receivable", "collect", "invoice")) {
    return `You're owed ${fmt(d.receivable)} in unpaid invoices. Chasing these turns ` +
      `receivables into cash — check the Invoices page for who's overdue.`;
  }
  if (has("bill", "payable", "vendor", "supplier owe", "i owe")) {
    return `You owe ${fmt(d.payable)} in unpaid bills. Prioritise anything overdue on ` +
      `the Bills page to protect supplier relationships.`;
  }
  if (has("stock", "inventory", "reorder", "product")) {
    return `Your inventory is worth ${fmt(d.inventoryValue)}, with ${d.lowStockCount} ` +
      `item(s) low or out of stock. Reorder low items from the Inventory page before ` +
      `they cost you sales.`;
  }
  if (has("payroll", "staff", "salary", "employee", "wage", "hire")) {
    return `You have ${d.employeeCount} employee(s) costing ${fmt(d.monthlyPayroll)} a ` +
      `month in gross pay — that's ${d.revenue > 0 ? Math.round((d.monthlyPayroll / d.revenue) * 100) : 0}% ` +
      `of revenue. Keep an eye on this ratio as you grow.`;
  }
  // General health summary, with the latest month's trend.
  const trendBit = d.thisMonth && d.lastMonth
    ? ` This month's net ${fmt(d.thisMonth.net)} vs ${fmt(d.lastMonth.net)} last month.`
    : "";
  return `Here's where ${d.name} stands (to date): ${fmt(d.revenue)} revenue, ` +
    `${fmt(d.expenses)} expenses, ${fmt(d.netProfit)} net profit (${d.margin.toFixed(0)}% ` +
    `margin). Cash ${fmt(d.cash)}, owed ${fmt(d.receivable)}, owing ${fmt(d.payable)}.` +
    `${trendBit} Ask about trends, profit, cash, costs to cut, tax, invoices, bills, ` +
    `inventory, or payroll.`;
}

export async function ask(question, data, fmt) {
  if (aiEnabled()) {
    return llmAnswer(question, data, fmt);
  }
  return { text: heuristicAnswer(question, data, fmt), mode: "offline" };
}
