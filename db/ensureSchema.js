import { pool } from "./index.js";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'KES',
    base_currency TEXT NOT NULL DEFAULT 'KES',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- base_currency was added after launch: backfill existing users so their
  -- stored amounts stay pinned to whatever they were entered in.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS base_currency TEXT;
  UPDATE users SET base_currency = currency WHERE base_currency IS NULL;

  -- Wallets: cash, bank, mobile money, credit card.
  CREATE TABLE IF NOT EXISTS accounts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'cash',
    balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- user_id IS NULL marks a built-in default category shared by everyone.
  CREATE TABLE IF NOT EXISTS categories (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
    icon TEXT NOT NULL DEFAULT '💸'
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    note TEXT,
    occurred_on DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_user_date
    ON transactions (user_id, occurred_on DESC);

  -- month is always the first day of the month the budget applies to.
  CREATE TABLE IF NOT EXISTS budgets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    month DATE NOT NULL,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    UNIQUE (user_id, category_id, month)
  );

  CREATE TABLE IF NOT EXISTS goals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target_amount NUMERIC(12, 2) NOT NULL CHECK (target_amount > 0),
    saved_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
    target_date DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Uploaded receipt photos plus what the analytics service read off them.
  CREATE TABLE IF NOT EXISTS receipts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    merchant TEXT,
    total NUMERIC(12, 2),
    purchased_on DATE,
    items JSONB NOT NULL DEFAULT '[]',
    ocr_text TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Templates that auto-create transactions on a schedule (rent, salary,
  -- subscriptions). Due ones are materialized lazily when the user loads the
  -- app; next_run tracks the following occurrence. Amounts are base currency.
  CREATE TABLE IF NOT EXISTS recurring_transactions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    note TEXT,
    frequency TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'yearly')),
    next_run DATE NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Loans/debts. principal is the balance when tracking starts (amount owed
  -- now, or amount borrowed for a brand-new loan); interest accrues monthly on
  -- the running balance from start_date, reduced by logged loan_payments.
  -- Amounts are base currency.
  CREATE TABLE IF NOT EXISTS loans (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    lender TEXT,
    principal NUMERIC(12, 2) NOT NULL CHECK (principal >= 0),
    apr NUMERIC(6, 3) NOT NULL DEFAULT 0 CHECK (apr >= 0),
    minimum_payment NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (minimum_payment >= 0),
    start_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS loan_payments (
    id SERIAL PRIMARY KEY,
    loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    paid_on DATE NOT NULL DEFAULT CURRENT_DATE,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- transaction_id links a payment to the expense it posts to the ledger.
  -- ON DELETE CASCADE: removing that expense removes the payment too, so the
  -- loan balance stays in sync. (Added after loan_payments shipped.)
  ALTER TABLE loan_payments
    ADD COLUMN IF NOT EXISTS transaction_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE;
  -- Migrate databases where this FK originally shipped as ON DELETE SET NULL.
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'loan_payments_transaction_id_fkey'
        AND conrelid = 'loan_payments'::regclass
        AND confdeltype <> 'c'
    ) THEN
      ALTER TABLE loan_payments DROP CONSTRAINT loan_payments_transaction_id_fkey;
      ALTER TABLE loan_payments
        ADD CONSTRAINT loan_payments_transaction_id_fkey
        FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE;
    END IF;
  END $$;

  CREATE INDEX IF NOT EXISTS idx_loan_payments_loan
    ON loan_payments (loan_id, paid_on);

  -- Category used when a loan payment posts as an expense. Idempotent so it
  -- exists even on databases seeded before this category was added.
  INSERT INTO categories (user_id, name, kind, icon)
  SELECT NULL, 'Loan Payment', 'expense', '🏦'
  WHERE NOT EXISTS (
    SELECT 1 FROM categories WHERE user_id IS NULL AND name = 'Loan Payment'
  );

  -- Business accounting: a user can run one or more businesses, each with its
  -- own books kept separate from personal finances. Amounts are base currency.
  CREATE TABLE IF NOT EXISTS businesses (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    industry TEXT,
    income_tax_rate NUMERIC(5, 2) NOT NULL DEFAULT 30,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- income_tax_rate added after businesses shipped; backfill existing rows.
  ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS income_tax_rate NUMERIC(5, 2) NOT NULL DEFAULT 30;

  CREATE TABLE IF NOT EXISTS business_transactions (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
    amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    category TEXT NOT NULL DEFAULT 'Other',
    note TEXT,
    occurred_on DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_business_tx_business
    ON business_transactions (business_id, occurred_on DESC);

  -- Inventory: stock items for a business. quantity is on-hand units;
  -- reorder_point is the low-stock threshold; reorder_qty is how many to
  -- order when restocking. Money fields are base currency.
  CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sku TEXT,
    quantity NUMERIC(12, 2) NOT NULL DEFAULT 0,
    unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
    sale_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
    reorder_point NUMERIC(12, 2) NOT NULL DEFAULT 0,
    reorder_qty NUMERIC(12, 2) NOT NULL DEFAULT 0,
    supplier TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Purchase orders and their line items. Receiving an order adds its
  -- quantities to stock and posts its cost to the business ledger.
  CREATE TABLE IF NOT EXISTS purchase_orders (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    supplier TEXT,
    status TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered', 'received')),
    total NUMERIC(14, 2) NOT NULL DEFAULT 0,
    note TEXT,
    received_on DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS purchase_order_items (
    id SERIAL PRIMARY KEY,
    po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    quantity NUMERIC(12, 2) NOT NULL,
    unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0
  );

  -- Payroll: employees and the pay runs that pay them. pay_rate is a monthly
  -- salary or an hourly rate; deduction_rate is the % withheld for tax and
  -- statutory contributions. Money fields are base currency.
  CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT,
    pay_type TEXT NOT NULL DEFAULT 'monthly' CHECK (pay_type IN ('monthly', 'hourly')),
    pay_rate NUMERIC(14, 2) NOT NULL DEFAULT 0,
    hours NUMERIC(8, 2) NOT NULL DEFAULT 0,
    deduction_rate NUMERIC(5, 2) NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS pay_runs (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id INTEGER REFERENCES business_transactions(id) ON DELETE SET NULL,
    period TEXT NOT NULL,
    gross_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
    deduction_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
    net_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
    employee_count INTEGER NOT NULL DEFAULT 0,
    run_on DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS payslips (
    id SERIAL PRIMARY KEY,
    pay_run_id INTEGER NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    gross NUMERIC(14, 2) NOT NULL DEFAULT 0,
    deductions NUMERIC(14, 2) NOT NULL DEFAULT 0,
    net NUMERIC(14, 2) NOT NULL DEFAULT 0
  );

  -- Money a business sets aside toward its tax bill. Amounts are base currency.
  CREATE TABLE IF NOT EXISTS tax_provisions (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    note TEXT,
    set_on DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Monthly budget targets for a business: a revenue target (kind = income,
  -- category = 'Revenue') and spending targets per expense category. Amounts
  -- are base currency.
  CREATE TABLE IF NOT EXISTS business_budgets (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
    category TEXT NOT NULL,
    amount NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
    UNIQUE (business_id, kind, category)
  );
`;

const DEFAULT_CATEGORIES = [
  ["Food & Dining", "expense", "🍔"],
  ["Transport", "expense", "🚌"],
  ["Housing", "expense", "🏠"],
  ["Utilities", "expense", "💡"],
  ["Shopping", "expense", "🛍️"],
  ["Entertainment", "expense", "🎬"],
  ["Health", "expense", "⚕️"],
  ["Education", "expense", "📚"],
  ["Other", "expense", "🧾"],
  ["Loan Payment", "expense", "🏦"],
  ["Salary", "income", "💼"],
  ["Business", "income", "🏪"],
  ["Gifts", "income", "🎁"],
  ["Other Income", "income", "💰"]
];

async function seedDefaultCategories() {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS count FROM categories WHERE user_id IS NULL"
  );

  if (rows[0].count > 0) {
    return;
  }

  for (const [name, kind, icon] of DEFAULT_CATEGORIES) {
    await pool.query(
      "INSERT INTO categories (user_id, name, kind, icon) VALUES (NULL, $1, $2, $3)",
      [name, kind, icon]
    );
  }

  console.info("Seeded default categories");
}

// Best-effort: returns false instead of throwing so the app can still boot
// (public pages, in-memory sessions) before PostgreSQL is configured.
export async function ensureSchema() {
  try {
    await pool.query(SCHEMA_SQL);
    await seedDefaultCategories();
    console.info("Database schema is ready");
    return true;
  } catch (error) {
    console.warn("Database unavailable — starting without persistence.");
    console.warn(`  (${error.message})`);
    console.warn("  Copy .env.example to .env, point it at PostgreSQL, and restart.");
    return false;
  }
}
