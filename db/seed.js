#!/usr/bin/env node
//
// Fills a fresh database with a worked example of every part of Cashflow, so
// a clone opens on a working app instead of empty pages.
//
//   npm run seed          create the demo account (does nothing if it exists)
//   npm run seed:reset    delete it and build it again
//
// Everything is dated relative to today, so the demo never looks stale, and it
// all hangs off one user — deleting that user cascades the lot away.

import bcrypt from "bcrypt";

import { pool } from "./index.js";
import { ensureSchema } from "./ensureSchema.js";
import { toISODate } from "../utils/dates.js";

const args = new Set(process.argv.slice(2));
const RESET = args.has("--reset");
const FORCE = args.has("--force");

const EMAIL = process.env.DEMO_EMAIL || "demo@cashflow.local";
const PASSWORD = process.env.DEMO_PASSWORD || "growmoney123";
const NAME = process.env.DEMO_NAME || "Demo User";
const CURRENCY = process.env.DEMO_CURRENCY || "KES";

const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

// --- Dates, all relative to the day the seed runs ---

const now = new Date();
const daysAgo = (n) => toISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
const daysAhead = (n) => daysAgo(-n);

// A day inside a month `back` months ago, clamped to that month's length.
function dayOf(back, day) {
  const first = new Date(now.getFullYear(), now.getMonth() - back, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return toISODate(new Date(first.getFullYear(), first.getMonth(), Math.min(day, last)));
}

const monthStartOf = (back) => dayOf(back, 1);

async function categoryId(name) {
  const row = await one(
    "SELECT id FROM categories WHERE user_id IS NULL AND name = $1", [name]
  );
  if (!row) throw new Error(`Default category "${name}" is missing.`);
  return row.id;
}

// --- Personal finances ---

async function seedPersonal(userId) {
  const accounts = {};
  for (const [key, name, type, opening] of [
    ["mpesa", "M-Pesa", "mobile", 18500],
    ["cash", "Cash", "cash", 4200],
    ["bank", "Equity Bank", "bank", 96000]
  ]) {
    const row = await one(
      `INSERT INTO accounts (user_id, name, type, balance)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, name, type, opening]
    );
    accounts[key] = { id: row.id, balance: opening };
  }

  // Three months of ordinary life: salary in, the usual bills out.
  const entries = [];
  for (let back = 2; back >= 0; back -= 1) {
    entries.push(
      ["bank", "Salary", "income", 85000, "Monthly salary", dayOf(back, 5)],
      ["bank", "Housing", "expense", 25000, "Rent", dayOf(back, 6)],
      ["mpesa", "Utilities", "expense", 3200, "Power and water", dayOf(back, 8)],
      ["mpesa", "Food & Dining", "expense", 4800, "Weekly shopping", dayOf(back, 9)],
      ["cash", "Transport", "expense", 2400, "Matatu fare", dayOf(back, 11)],
      ["mpesa", "Food & Dining", "expense", 5100, "Weekly shopping", dayOf(back, 16)],
      ["cash", "Transport", "expense", 2200, "Matatu fare", dayOf(back, 18)],
      ["mpesa", "Entertainment", "expense", 1800, "Streaming and a night out", dayOf(back, 20)],
      ["mpesa", "Food & Dining", "expense", 4650, "Weekly shopping", dayOf(back, 23)],
      ["cash", "Health", "expense", 2600, "Pharmacy", dayOf(back, 24)],
      ["mpesa", "Shopping", "expense", 3900, "Household bits", dayOf(back, 26)]
    );
  }
  // A little freelance income, most recently.
  entries.push(["mpesa", "Other Income", "income", 12000, "Weekend freelance job", daysAgo(9)]);

  for (const [account, category, kind, amount, note, on] of entries) {
    await q(
      `INSERT INTO transactions
         (user_id, account_id, category_id, kind, amount, note, occurred_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, accounts[account].id, await categoryId(category), kind, amount, note, on]
    );
    accounts[account].balance += kind === "income" ? amount : -amount;
  }

  for (const account of Object.values(accounts)) {
    await q("UPDATE accounts SET balance = $1 WHERE id = $2", [account.balance, account.id]);
  }

  // Budgets for the month in progress, one of them deliberately under strain.
  for (const [category, amount] of [
    ["Food & Dining", 18000], ["Transport", 6000],
    ["Entertainment", 4000], ["Shopping", 8000]
  ]) {
    await q(
      `INSERT INTO budgets (user_id, category_id, month, amount)
       VALUES ($1, $2, $3, $4)`,
      [userId, await categoryId(category), monthStartOf(0), amount]
    );
  }

  for (const [name, target, saved, due] of [
    ["Emergency fund", 300000, 145000, daysAhead(300)],
    ["Laptop upgrade", 120000, 38000, daysAhead(120)]
  ]) {
    await q(
      `INSERT INTO goals (user_id, name, target_amount, saved_amount, target_date)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, name, target, saved, due]
    );
  }

  // A loan, with two payments that also show up in the ledger.
  const loan = await one(
    `INSERT INTO loans (user_id, name, lender, principal, apr, minimum_payment, start_date)
     VALUES ($1, 'Boda purchase loan', 'Equity Bank', 180000, 14.5, 9000, $2)
     RETURNING id`,
    [userId, dayOf(5, 12)]
  );
  for (const back of [1, 0]) {
    const paidOn = dayOf(back, 15);
    const tx = await one(
      `INSERT INTO transactions
         (user_id, account_id, category_id, kind, amount, note, occurred_on)
       VALUES ($1, $2, $3, 'expense', 9000, 'Loan repayment', $4)
       RETURNING id`,
      [userId, accounts.bank.id, await categoryId("Loan Payment"), paidOn]
    );
    await q(
      `INSERT INTO loan_payments (loan_id, user_id, transaction_id, amount, paid_on, note)
       VALUES ($1, $2, $3, 9000, $4, 'Monthly instalment')`,
      [loan.id, userId, tx.id, paidOn]
    );
    accounts.bank.balance -= 9000;
  }
  await q("UPDATE accounts SET balance = $1 WHERE id = $2",
    [accounts.bank.balance, accounts.bank.id]);

  for (const [category, kind, amount, note, frequency, nextRun] of [
    ["Housing", "expense", 25000, "Rent", "monthly", dayOf(-1, 6)],
    ["Salary", "income", 85000, "Monthly salary", "monthly", dayOf(-1, 5)]
  ]) {
    await q(
      `INSERT INTO recurring_transactions
         (user_id, account_id, category_id, kind, amount, note, frequency, next_run)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, accounts.bank.id, await categoryId(category), kind, amount, note,
       frequency, nextRun]
    );
  }

  return accounts;
}

// --- The shop ---

async function seedShop(userId) {
  const shop = await one(
    `INSERT INTO businesses (user_id, name, industry, income_tax_rate)
     VALUES ($1, 'Mama Njeri Grocers', 'Retail', 30)
     RETURNING id`,
    [userId]
  );

  // Trading history. Stock buying is a cash cost here; the income statement
  // holds back whatever is still on the shelves (see utils/statements.js).
  for (let back = 3; back >= 0; back -= 1) {
    const scale = 1 + (3 - back) * 0.08; // steady growth toward this month
    await q(
      `INSERT INTO business_transactions
         (business_id, user_id, kind, amount, category, note, occurred_on)
       VALUES ($1, $2, 'income', $3, 'Sales', 'Counter takings', $4)`,
      [shop.id, userId, Math.round(128000 * scale), dayOf(back, 27)]
    );
    await q(
      `INSERT INTO business_transactions
         (business_id, user_id, kind, amount, category, note, occurred_on)
       VALUES ($1, $2, 'expense', $3, 'Inventory Purchase', 'Stock for the month', $4)`,
      [shop.id, userId, Math.round(78000 * scale), dayOf(back, 3)]
    );
    for (const [amount, category, note, day] of [
      [12000, "Rent", "Shop rent", 2],
      [3800, "Utilities", "Power", 7],
      [42500, "Payroll", "Staff wages", 28]
    ]) {
      await q(
        `INSERT INTO business_transactions
           (business_id, user_id, kind, amount, category, note, occurred_on)
         VALUES ($1, $2, 'expense', $3, $4, $5, $6)`,
        [shop.id, userId, amount, category, note, dayOf(back, day)]
      );
    }
  }

  const products = {};
  for (const [name, sku, qty, cost, price, reorderPoint, reorderQty] of [
    ["Sugar 2kg", "SUG-2KG", 7, 220, 260, 10, 20],
    ["Milk 1L", "MLK-1L", 40, 55, 70, 15, 30],
    ["Bread", "BRD-400", 8, 50, 65, 20, 40],
    ["Cooking Oil 1L", "OIL-1L", 12, 300, 360, 6, 12],
    ["Maize Flour 2kg", "UGA-2KG", 26, 168, 205, 12, 24]
  ]) {
    const row = await one(
      `INSERT INTO products
         (business_id, user_id, name, sku, quantity, unit_cost, sale_price,
          reorder_point, reorder_qty, supplier)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Kicheko Wholesalers')
       RETURNING id`,
      [shop.id, userId, name, sku, qty, cost, price, reorderPoint, reorderQty]
    );
    products[name] = { id: row.id, cost, price };
  }

  // Over-the-counter sales: one paid, one still owed.
  for (const [payment, customer, when, lines] of [
    ["cash", "Wanjiru", daysAgo(1), [["Milk 1L", 6], ["Bread", 4]]],
    ["cash", null, daysAgo(0), [["Sugar 2kg", 3], ["Cooking Oil 1L", 1]]],
    ["credit", "Kariuki Hotel", daysAgo(2), [["Maize Flour 2kg", 10], ["Cooking Oil 1L", 4]]]
  ]) {
    const total = lines.reduce((s, [n, qty]) => s + qty * products[n].price, 0);
    const cost = lines.reduce((s, [n, qty]) => s + qty * products[n].cost, 0);
    const sale = await one(
      `INSERT INTO sales (business_id, user_id, customer, payment, total, cost_total, occurred_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [shop.id, userId, customer, payment, total, cost, when]
    );
    for (const [name, qty] of lines) {
      await q(
        `INSERT INTO sale_items (sale_id, product_id, name, quantity, unit_price, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sale.id, products[name].id, name, qty, products[name].price, products[name].cost]
      );
    }

    if (payment === "credit") {
      const invoice = await one(
        `INSERT INTO invoices
           (business_id, user_id, customer, amount, category, issued_on, due_on, note)
         VALUES ($1, $2, $3, $4, 'Sales', $5, $6, $7) RETURNING id`,
        [shop.id, userId, customer, total, when, daysAhead(12), `Sale #${sale.id}`]
      );
      await q("UPDATE sales SET invoice_id = $1 WHERE id = $2", [invoice.id, sale.id]);
    } else {
      const tx = await one(
        `INSERT INTO business_transactions
           (business_id, user_id, kind, amount, category, note, occurred_on)
         VALUES ($1, $2, 'income', $3, 'Sales', $4, $5) RETURNING id`,
        [shop.id, userId, total, `Sale #${sale.id}`, when]
      );
      await q("UPDATE sales SET transaction_id = $1 WHERE id = $2", [tx.id, sale.id]);
    }
  }

  // Payroll: two on salary, one hourly, and last month's run.
  const staff = [];
  for (const [name, role, payType, rate, hours, deduction] of [
    ["Grace Wambui", "Shop manager", "monthly", 32000, 0, 12],
    ["John Otieno", "Shop assistant", "monthly", 21000, 0, 10],
    ["Mary Achieng", "Weekend help", "hourly", 320, 48, 5]
  ]) {
    const row = await one(
      `INSERT INTO employees
         (business_id, user_id, name, role, pay_type, pay_rate, hours, deduction_rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [shop.id, userId, name, role, payType, rate, hours, deduction]
    );
    const gross = payType === "monthly" ? rate : rate * hours;
    staff.push({ id: row.id, name, gross, deductions: (gross * deduction) / 100 });
  }

  const gross = staff.reduce((s, e) => s + e.gross, 0);
  const deductions = staff.reduce((s, e) => s + e.deductions, 0);
  const payTx = await one(
    `INSERT INTO business_transactions
       (business_id, user_id, kind, amount, category, note, occurred_on)
     VALUES ($1, $2, 'expense', $3, 'Payroll', 'Payroll run', $4) RETURNING id`,
    [shop.id, userId, gross, dayOf(1, 28)]
  );
  const run = await one(
    `INSERT INTO pay_runs
       (business_id, user_id, transaction_id, period, gross_total, deduction_total,
        net_total, employee_count, run_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [shop.id, userId, payTx.id, monthStartOf(1).slice(0, 7), gross, deductions,
     gross - deductions, staff.length, dayOf(1, 28)]
  );
  for (const employee of staff) {
    await q(
      `INSERT INTO payslips (pay_run_id, employee_id, name, gross, deductions, net)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [run.id, employee.id, employee.name, employee.gross, employee.deductions,
       employee.gross - employee.deductions]
    );
  }

  await q(
    `INSERT INTO tax_provisions (business_id, user_id, amount, note, set_on)
     VALUES ($1, $2, 10000, 'Set aside from a good month', $3)`,
    [shop.id, userId, dayOf(1, 30)]
  );

  for (const [kind, category, amount] of [
    ["income", "Revenue", 150000],
    ["expense", "Inventory Purchase", 85000],
    ["expense", "Payroll", 40000],
    ["expense", "Rent", 12000],
    ["expense", "Utilities", 4500]
  ]) {
    await q(
      `INSERT INTO business_budgets (business_id, user_id, kind, category, amount)
       VALUES ($1, $2, $3, $4, $5)`,
      [shop.id, userId, kind, category, amount]
    );
  }

  await q(
    `INSERT INTO invoices
       (business_id, user_id, customer, amount, category, issued_on, due_on, note)
     VALUES ($1, $2, 'Nairobi Catering Co.', 24500, 'Sales', $3, $4, 'Bulk order')`,
    [shop.id, userId, daysAgo(11), daysAhead(19)]
  );
  await q(
    `INSERT INTO bills
       (business_id, user_id, vendor, amount, category, issued_on, due_on, note)
     VALUES ($1, $2, 'Kenya Power', 4100, 'Utilities', $3, $4, 'Monthly power bill')`,
    [shop.id, userId, daysAgo(6), daysAhead(9)]
  );

  return { shop, products };
}

// --- The wholesaler on the other side of the supply chain ---

async function seedSupplier(userId, shop, shopProducts) {
  // A supplier account, not a business: it sells to businesses and keeps no
  // books of its own.
  const supplier = await one(
    `INSERT INTO suppliers (user_id, name, industry, lead_time_days, supply_code)
     VALUES ($1, 'Kicheko Wholesalers', 'Wholesale', 2,
             'CF-' || upper(substr(md5('cashflow-supply-kicheko'), 1, 6)))
     RETURNING id`,
    [userId]
  );

  const catalog = {};
  for (const [name, sku, qty, cost, price] of [
    ["Sugar 2kg", "SUG-2KG", 420, 195, 220],
    ["Milk 1L", "MLK-1L", 310, 47, 55],
    ["Bread", "BRD-400", 260, 42, 50],
    ["Cooking Oil 1L", "OIL-1L", 140, 265, 300],
    ["Maize Flour 2kg", "UGA-2KG", 280, 150, 168],
    ["Rice 5kg", "RCE-5KG", 95, 690, 780]
  ]) {
    const row = await one(
      `INSERT INTO supplier_products
         (supplier_id, user_id, name, sku, quantity, unit_cost, sale_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [supplier.id, userId, name, sku, qty, cost, price]
    );
    catalog[name] = { id: row.id, price };
  }

  await q(
    `INSERT INTO trade_partners (buyer_business_id, supplier_id, requested_by, status)
     VALUES ($1, $2, $3, 'active')`,
    [shop.id, supplier.id, userId]
  );

  // Deliveries already made, one of them two days late, so the supplier
  // scorecard and the delivery estimate have something to work from.
  const history = [
    { placed: 52, promised: 50, delivered: 50, lines: [["Sugar 2kg", 20], ["Bread", 40]] },
    { placed: 34, promised: 32, delivered: 30, lines: [["Milk 1L", 30], ["Cooking Oil 1L", 12]] },
    { placed: 17, promised: 15, delivered: 15, lines: [["Sugar 2kg", 20], ["Maize Flour 2kg", 25]] }
  ];

  for (const entry of history) {
    const total = entry.lines.reduce((s, [n, qty]) => s + qty * catalog[n].price, 0);
    const order = await one(
      `INSERT INTO supply_orders
         (buyer_business_id, buyer_user_id, supplier_id, supplier_user_id,
          status, currency, total, note, placed_on, expected_on, promised_on,
          confirmed_at, shipped_at, delivered_at, received_at)
       VALUES ($1, $2, $3, $2, 'received', $4, $5, 'Weekly restock',
               $6, $7, $7, $6::date + TIME '09:20', $6::date + TIME '16:40',
               $8::date + TIME '08:15', $8::date + TIME '10:05')
       RETURNING id`,
      [shop.id, userId, supplier.id, CURRENCY, total,
       daysAgo(entry.placed), daysAgo(entry.promised), daysAgo(entry.delivered)]
    );

    for (const [name, qty] of entry.lines) {
      await q(
        `INSERT INTO supply_order_items
           (order_id, catalog_product_id, buyer_product_id, name, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, catalog[name].id, shopProducts[name]?.id || null, name, qty,
         catalog[name].price]
      );
    }

    // No invoice on the supplier's side: a supplier keeps no books here, so the
    // order records its own settlement instead.
    const bill = await one(
      `INSERT INTO bills
         (business_id, user_id, vendor, amount, category, issued_on, due_on, note, status, paid_on)
       VALUES ($1, $2, 'Kicheko Wholesalers', $3, 'Inventory Purchase', $4, $5, $6, 'paid', $4)
       RETURNING id`,
      [shop.id, userId, total, daysAgo(entry.delivered), daysAhead(30),
       `Supply order #${order.id}`]
    );
    await q("UPDATE supply_orders SET bill_id = $1, paid_at = $2 WHERE id = $3",
      [bill.id, daysAgo(entry.delivered), order.id]);

    const units = entry.lines.reduce((s, [, qty]) => s + qty, 0);
    for (const [business, body] of [
      [shop.id, `Mama Njeri Grocers placed order #${order.id} — ${entry.lines.length} line(s), ${units} unit(s).`],
      [null, `Kicheko Wholesalers confirmed the order and committed to a delivery date.`],
      [null, `Kicheko Wholesalers shipped the order.`],
      [null, `Kicheko Wholesalers marked the order delivered.`],
      [shop.id, `Mama Njeri Grocers received the order — ${units} unit(s) into stock. Bill #${bill.id} added to payables.`]
    ]) {
      await q(
        `INSERT INTO supply_messages (order_id, business_id, user_id, kind, body, created_at)
         VALUES ($1, $2, $3, 'event', $4, $5::date + TIME '12:00')`,
        [order.id, business, userId, body, daysAgo(entry.placed)]
      );
    }
  }

  // And one still in flight, so the live side of the supply chain has
  // something to demonstrate the moment you open it.
  const openLines = [["Sugar 2kg", 20], ["Bread", 40]];
  const openTotal = openLines.reduce((s, [n, qty]) => s + qty * catalog[n].price, 0);
  const open = await one(
    `INSERT INTO supply_orders
       (buyer_business_id, buyer_user_id, supplier_id, supplier_user_id,
        status, currency, total, note, placed_on, expected_on)
     VALUES ($1, $2, $3, $2, 'placed', $4, $5, 'Morning delivery if possible', $6, $7)
     RETURNING id`,
    [shop.id, userId, supplier.id, CURRENCY, openTotal, daysAgo(0), daysAhead(2)]
  );
  for (const [name, qty] of openLines) {
    await q(
      `INSERT INTO supply_order_items
         (order_id, catalog_product_id, buyer_product_id, name, quantity, unit_price)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [open.id, catalog[name].id, shopProducts[name]?.id || null, name, qty, catalog[name].price]
    );
  }
  await q(
    `INSERT INTO supply_messages (order_id, business_id, user_id, kind, body)
     VALUES ($1, $2, $3, 'event', $4)`,
    [open.id, shop.id, userId,
     `Mama Njeri Grocers placed order #${open.id} — 2 line(s), 60 unit(s).`]
  );

  return supplier;
}

// --- Runner ---

async function main() {
  if (process.env.NODE_ENV === "production" && !FORCE) {
    console.error(
      "Refusing to seed a production database — this creates an account with a\n" +
      "known password. Pass --force if you really mean it."
    );
    process.exitCode = 1;
    return;
  }

  // ensureSchema has already said which of the two went wrong, and guessing
  // "no database" over the top of it buries the answer when it was the schema.
  if (!(await ensureSchema())) {
    console.error("Cannot seed until the schema is ready — see above.");
    process.exitCode = 1;
    return;
  }

  const existing = await one("SELECT id FROM users WHERE email = $1", [EMAIL]);
  if (existing && !RESET) {
    console.info(`${EMAIL} already exists — nothing to do. Use "npm run seed:reset" to rebuild it.`);
    return;
  }
  if (existing) {
    // Everything the demo owns hangs off this row and cascades away with it.
    await q("DELETE FROM users WHERE id = $1", [existing.id]);
    console.info("Removed the previous demo account.");
  }

  const user = await one(
    `INSERT INTO users (name, email, password_hash, currency, base_currency)
     VALUES ($1, $2, $3, $4, $4) RETURNING id`,
    [NAME, EMAIL, await bcrypt.hash(PASSWORD, 10), CURRENCY]
  );

  await seedPersonal(user.id);
  const { shop, products } = await seedShop(user.id);
  await seedSupplier(user.id, shop, products);

  const codes = await q(
    "SELECT name, supply_code FROM suppliers WHERE user_id = $1 ORDER BY id", [user.id]
  );

  console.info(`
Demo data ready.

  Sign in    ${EMAIL} / ${PASSWORD}
  Personal   3 wallets, 3 months of transactions, budgets, 2 goals, a loan, 2 recurring rules
  Business   Mama Njeri Grocers
             books, stock, sales, payroll, tax, budgets, invoices and bills
  Supplier   ${codes.map((c) => `${c.name} (${c.supply_code})`).join(", ")}
  Supply     3 delivered orders plus one still open, live on both sides

  For local demos only — the password above is public in this repo.
`);
}

try {
  await main();
} catch (error) {
  console.error(`Seeding failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
