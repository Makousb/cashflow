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

  -- Accounts receivable: money owed to the business by customers. Marking an
  -- invoice paid posts the income to the ledger (transaction_id links it).
  CREATE TABLE IF NOT EXISTS invoices (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id INTEGER REFERENCES business_transactions(id) ON DELETE SET NULL,
    customer TEXT NOT NULL,
    amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    category TEXT NOT NULL DEFAULT 'Sales',
    issued_on DATE NOT NULL DEFAULT CURRENT_DATE,
    due_on DATE,
    status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid')),
    paid_on DATE,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Accounts payable: bills the business owes to vendors. Marking a bill paid
  -- posts the expense to the ledger.
  CREATE TABLE IF NOT EXISTS bills (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id INTEGER REFERENCES business_transactions(id) ON DELETE SET NULL,
    vendor TEXT NOT NULL,
    amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    category TEXT NOT NULL DEFAULT 'Other',
    issued_on DATE NOT NULL DEFAULT CURRENT_DATE,
    due_on DATE,
    status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid')),
    paid_on DATE,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Buying stock stopped being an expense of the period when the income
  -- statement moved to accrual, so the category it posts under was renamed to
  -- say what it is. This is a label-only migration: both names have always been
  -- pooled by utils/statements.js, so no figure moves. Budgets are only renamed
  -- where it cannot collide with an existing row, since they are unique per
  -- business, kind and category.
  UPDATE business_transactions SET category = 'Inventory Purchase'
  WHERE category = 'Cost of Goods';

  UPDATE bills SET category = 'Inventory Purchase'
  WHERE category = 'Cost of Goods';

  UPDATE business_budgets b SET category = 'Inventory Purchase'
  WHERE b.category = 'Cost of Goods'
    AND NOT EXISTS (
      SELECT 1 FROM business_budgets other
      WHERE other.business_id = b.business_id
        AND other.kind = b.kind
        AND other.category = 'Inventory Purchase'
    );

  -- Opt a business into a monthly close. last_auto_review holds the first of
  -- the month whose review has been claimed, which is what stops two page
  -- loads racing each other into running it twice.
  ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS auto_review BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE businesses ADD COLUMN IF NOT EXISTS last_auto_review DATE;

  -- Where to send the monthly close. Null means nowhere, so notification is
  -- opt-in by construction. It is an address rather than a flag so the close
  -- can go to a bookkeeper who does not have a login here.
  ALTER TABLE businesses ADD COLUMN IF NOT EXISTS review_email TEXT;

  -- Which side of the app this account signed up for. It decides where they
  -- land and what the navigation offers; it is a starting point, not a cage —
  -- any account can add the other sides later.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'personal';
  UPDATE users SET account_type = 'personal' WHERE account_type IS NULL;

  -- Suppliers are their own thing, not a business with a flag set. A supplier
  -- sells to businesses and does not keep books here: it has a catalog, orders
  -- and the money those orders are worth, and that is all.
  CREATE TABLE IF NOT EXISTS suppliers (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    industry TEXT,
    supply_code TEXT,
    lead_time_days INTEGER NOT NULL DEFAULT 3,
    accepting_orders BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_code ON suppliers (supply_code);

  -- What a supplier sells. Separate from products, which are a business's own
  -- stock: the two are priced differently and answer to different owners.
  CREATE TABLE IF NOT EXISTS supplier_products (
    id SERIAL PRIMARY KEY,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sku TEXT,
    quantity NUMERIC(12, 2) NOT NULL DEFAULT 0,
    unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
    sale_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_supplier_products_supplier
    ON supplier_products (supplier_id, name);

  -- Marketing: funnels that capture leads, the people they capture, and the
  -- promotions sent to them.
  --
  -- The consent rules are in the schema rather than the UI on purpose. A
  -- contact carries when and how it consented; status decides whether anything
  -- may ever be sent to it; and unsubscribe_token lets someone leave from the
  -- email itself, without an account and without asking the business.
  CREATE TABLE IF NOT EXISTS funnels (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    headline TEXT NOT NULL,
    subhead TEXT,
    offer TEXT,
    cta TEXT NOT NULL DEFAULT 'Get the offer',
    -- What the visitor is promised in exchange for their address.
    incentive TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'paused')),
    views INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'offline' CHECK (mode IN ('ai', 'offline')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_funnels_business
    ON funnels (business_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS contacts (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    funnel_id INTEGER REFERENCES funnels(id) ON DELETE SET NULL,
    email TEXT NOT NULL,
    name TEXT,
    -- subscribed is the only status that may ever receive a promotion.
    status TEXT NOT NULL DEFAULT 'subscribed'
      CHECK (status IN ('subscribed', 'unsubscribed', 'bounced')),
    stage TEXT NOT NULL DEFAULT 'lead'
      CHECK (stage IN ('lead', 'engaged', 'customer', 'lapsed')),
    source TEXT,
    consent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consent_source TEXT NOT NULL DEFAULT 'funnel',
    unsubscribed_at TIMESTAMPTZ,
    unsubscribe_token TEXT NOT NULL,
    last_emailed_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- One row per person per business, however many times they sign up.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_business_email
    ON contacts (business_id, lower(email));
  CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_token
    ON contacts (unsubscribe_token);

  CREATE TABLE IF NOT EXISTS campaigns (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    segment TEXT NOT NULL DEFAULT 'all',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent')),
    sent_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL DEFAULT 'offline' CHECK (mode IN ('ai', 'offline')),
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- The relationship, as it happened. Everything that touches a contact leaves
  -- a row here, which is what the CRM timeline reads back.
  CREATE TABLE IF NOT EXISTS contact_events (
    id SERIAL PRIMARY KEY,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
    kind TEXT NOT NULL
      CHECK (kind IN ('captured', 'emailed', 'unsubscribed', 'purchased', 'note', 'stage')),
    detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_contact_events_contact
    ON contact_events (contact_id, created_at DESC);

  -- A record of every close the accounting agent has run. The findings are kept
  -- as they were written so a past review can be read back exactly, rather than
  -- recomputed against books that have since moved on.
  CREATE TABLE IF NOT EXISTS accounting_reviews (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    findings_total INTEGER NOT NULL DEFAULT 0,
    findings_high INTEGER NOT NULL DEFAULT 0,
    taxable_profit NUMERIC(14, 2) NOT NULL DEFAULT 0,
    tax_owed NUMERIC(14, 2) NOT NULL DEFAULT 0,
    tax_shortfall NUMERIC(14, 2) NOT NULL DEFAULT 0,
    narrative TEXT,
    -- Whether the covering note was written by the configured AI provider or
    -- assembled here. The figures are the same either way.
    mode TEXT NOT NULL DEFAULT 'offline' CHECK (mode IN ('ai', 'offline')),
    findings JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Who was told about this review, and when. Null means nobody was.
    notified_to TEXT,
    notified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Added after accounting_reviews shipped. The columns above only reach a
  -- database that is being created from scratch, so existing books need these.
  ALTER TABLE accounting_reviews ADD COLUMN IF NOT EXISTS notified_to TEXT;
  ALTER TABLE accounting_reviews ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

  CREATE INDEX IF NOT EXISTS idx_accounting_reviews_business
    ON accounting_reviews (business_id, created_at DESC);

  -- Sales: what the business sells over the counter. Recording one takes the
  -- units off the shelf and books the money. cost_total captures what those
  -- units cost at the moment they were sold, so margin is measured against the
  -- price actually paid for that stock rather than today's price.
  CREATE TABLE IF NOT EXISTS sales (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    transaction_id INTEGER REFERENCES business_transactions(id) ON DELETE SET NULL,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    customer TEXT,
    payment TEXT NOT NULL DEFAULT 'cash' CHECK (payment IN ('cash', 'credit')),
    total NUMERIC(14, 2) NOT NULL DEFAULT 0,
    cost_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
    note TEXT,
    occurred_on DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_sales_business
    ON sales (business_id, occurred_on DESC);

  -- product_id is null for anything sold that is not stocked (a service, a
  -- one-off); those lines move money without moving inventory.
  CREATE TABLE IF NOT EXISTS sale_items (
    id SERIAL PRIMARY KEY,
    sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    sku TEXT,
    quantity NUMERIC(12, 2) NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
    unit_cost NUMERIC(12, 2) NOT NULL DEFAULT 0
  );

  -- Supply chain: businesses trade with each other inside Cashflow. Any
  -- business can buy; one that flips is_supplier on also sells, publishing its
  -- products as a catalog. supply_code is the handle a buyer types to connect;
  -- lead_time_days is the turnaround the supplier promises.
  ALTER TABLE businesses ADD COLUMN IF NOT EXISTS supply_code TEXT;
  ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS is_supplier BOOLEAN NOT NULL DEFAULT FALSE;
  ALTER TABLE businesses
    ADD COLUMN IF NOT EXISTS lead_time_days INTEGER NOT NULL DEFAULT 3;

  -- Deterministic backfill so existing businesses get a stable code. It also
  -- reissues the codes minted under the app's old name — they carried an MT-
  -- prefix and a different hash, so a code shared before the rename no longer
  -- resolves. Partnerships are held by id, so those are unaffected.
  UPDATE businesses
  SET supply_code = 'CF-' || upper(substr(md5('cashflow-supply-' || id::text), 1, 6))
  WHERE supply_code IS NULL OR supply_code LIKE 'MT-%';

  CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_supply_code
    ON businesses (supply_code);

  -- A trading relationship, requested by the buyer and accepted by the
  -- supplier. Both sides are businesses, which may belong to different users.
  CREATE TABLE IF NOT EXISTS trade_partners (
    id SERIAL PRIMARY KEY,
    buyer_business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    supplier_business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'active', 'declined')),
    requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (buyer_business_id, supplier_business_id),
    CHECK (buyer_business_id <> supplier_business_id)
  );

  -- A supply order travels: placed by the buyer, confirmed/shipped/delivered by
  -- the supplier, then received by the buyer (which stocks it and raises the
  -- bill). Amounts are stored in the buyer's base currency, recorded in
  -- currency so the supplier can convert for their own display.
  CREATE TABLE IF NOT EXISTS supply_orders (
    id SERIAL PRIMARY KEY,
    buyer_business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    buyer_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    supplier_business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    supplier_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'placed'
      CHECK (status IN ('placed', 'confirmed', 'shipped', 'delivered',
                        'received', 'cancelled', 'declined')),
    currency TEXT NOT NULL DEFAULT 'KES',
    total NUMERIC(14, 2) NOT NULL DEFAULT 0,
    note TEXT,
    tracking TEXT,
    expected_on DATE,
    promised_on DATE,
    placed_on DATE NOT NULL DEFAULT CURRENT_DATE,
    confirmed_at TIMESTAMPTZ,
    shipped_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    bill_id INTEGER REFERENCES bills(id) ON DELETE SET NULL,
    invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_supply_orders_buyer
    ON supply_orders (buyer_business_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_supply_orders_supplier
    ON supply_orders (supplier_business_id, created_at DESC);

  -- Line items reference the supplier's catalog product and, once the buyer
  -- receives the goods, the buyer's own stock item.
  CREATE TABLE IF NOT EXISTS supply_order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES supply_orders(id) ON DELETE CASCADE,
    supplier_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    buyer_product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    sku TEXT,
    quantity NUMERIC(12, 2) NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12, 2) NOT NULL DEFAULT 0
  );

  -- One thread per order carrying both sides' chat and the status events that
  -- happen to it, so the conversation and the audit trail read together.
  CREATE TABLE IF NOT EXISTS supply_messages (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES supply_orders(id) ON DELETE CASCADE,
    business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'event')),
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_supply_messages_order
    ON supply_messages (order_id, id);

  -- Personal credit: short-term loans, pay-in-instalments plans, and secured
  -- cards. Every application is kept, approved or not — a decline is only
  -- useful if it says what would have to change, and that reason is the row.
  CREATE TABLE IF NOT EXISTS credit_applications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product TEXT NOT NULL
      CHECK (product IN ('day_loan', 'bnpl', 'secured_card')),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    -- Days for a day loan, instalments for a plan, unused for a card.
    term INTEGER NOT NULL DEFAULT 0,
    purpose TEXT,
    status TEXT NOT NULL CHECK (status IN ('approved', 'declined')),
    reason TEXT NOT NULL,
    fee NUMERIC(12, 2) NOT NULL DEFAULT 0,
    apr NUMERIC(6, 2) NOT NULL DEFAULT 0,
    -- "limit" is reserved, hence the prefix.
    credit_limit NUMERIC(12, 2),
    deposit NUMERIC(12, 2),
    decided_on DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_credit_applications_user
    ON credit_applications (user_id, id DESC);

  -- What an approved application turns into: the thing that is actually owed.
  CREATE TABLE IF NOT EXISTS credit_facilities (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    application_id INTEGER REFERENCES credit_applications(id) ON DELETE SET NULL,
    product TEXT NOT NULL
      CHECK (product IN ('day_loan', 'bnpl', 'secured_card')),
    label TEXT NOT NULL,
    principal NUMERIC(12, 2) NOT NULL DEFAULT 0,
    fee NUMERIC(12, 2) NOT NULL DEFAULT 0,
    apr NUMERIC(6, 2) NOT NULL DEFAULT 0,
    credit_limit NUMERIC(12, 2),
    deposit NUMERIC(12, 2),
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'settled', 'closed')),
    opened_on DATE NOT NULL DEFAULT CURRENT_DATE,
    due_on DATE,
    -- The ledger entry that paid the money out, so closing can reverse it.
    transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_credit_facilities_user
    ON credit_facilities (user_id, status);

  -- The repayment schedule. A day loan has one row, a plan has one per
  -- instalment; a card has none, having nothing fixed to repay.
  CREATE TABLE IF NOT EXISTS credit_installments (
    id SERIAL PRIMARY KEY,
    facility_id INTEGER NOT NULL REFERENCES credit_facilities(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    due_on DATE NOT NULL,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    paid_on DATE,
    transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (facility_id, sequence)
  );

  CREATE INDEX IF NOT EXISTS idx_credit_installments_due
    ON credit_installments (user_id, due_on);

  -- What was put on a card. No ledger entry goes with a charge: the books here
  -- are cash basis, so the spending is recorded when the card is paid, not when
  -- it is used, and counting it in both places would count it twice.
  CREATE TABLE IF NOT EXISTS credit_charges (
    id SERIAL PRIMARY KEY,
    facility_id INTEGER NOT NULL REFERENCES credit_facilities(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    merchant TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    charged_on DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_credit_charges_facility
    ON credit_charges (user_id, facility_id, charged_on);

  -- Money paid towards a card balance. A card has no schedule to pay against,
  -- so these are free-form rather than instalments.
  CREATE TABLE IF NOT EXISTS credit_payments (
    id SERIAL PRIMARY KEY,
    facility_id INTEGER NOT NULL REFERENCES credit_facilities(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
    paid_on DATE NOT NULL DEFAULT CURRENT_DATE,
    transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_credit_payments_facility
    ON credit_payments (user_id, facility_id, paid_on);

  -- One row per statement anybody has been told about. Statements themselves
  -- are worked out rather than stored, so the cycle they belong to is the key,
  -- and the uniqueness of it is what stops the same missed payment being
  -- emailed about twice — two requests racing, one insert wins.
  CREATE TABLE IF NOT EXISTS credit_notices (
    id SERIAL PRIMARY KEY,
    facility_id INTEGER NOT NULL REFERENCES credit_facilities(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cycle TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'missed' CHECK (kind IN ('reminder', 'missed')),
    sent_to TEXT,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- A statement can now be written about twice: once before the date and once
  -- after it. The first version of this table allowed one notice per cycle
  -- full stop, so the old constraint has to go before the new key can mean
  -- anything. These sit here rather than with the supplier migration at the
  -- end because they touch only the table above them, which by this point in
  -- the batch exists.
  ALTER TABLE credit_notices ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'missed';
  ALTER TABLE credit_notices DROP CONSTRAINT IF EXISTS credit_notices_facility_id_cycle_key;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_notices_once
    ON credit_notices (facility_id, cycle, kind);

  -- The supplier migration comes last, once every table it touches has been
  -- created above. This is one statement batch run against a database that may
  -- be brand new, so an ALTER sitting next to the suppliers tables would reach
  -- a trade_partners that CREATE TABLE had not got to yet and abort the whole
  -- batch — leaving a fresh install with no schema at all. An existing database
  -- never noticed, because there the tables were already there.

  -- Trading now points at a supplier rather than at another business.
  ALTER TABLE trade_partners ADD COLUMN IF NOT EXISTS supplier_id INTEGER
    REFERENCES suppliers(id) ON DELETE CASCADE;
  ALTER TABLE supply_orders ADD COLUMN IF NOT EXISTS supplier_id INTEGER
    REFERENCES suppliers(id) ON DELETE CASCADE;
  ALTER TABLE supply_order_items ADD COLUMN IF NOT EXISTS catalog_product_id INTEGER
    REFERENCES supplier_products(id) ON DELETE SET NULL;
  -- A supplier has no ledger here, so an order records its own settlement.
  ALTER TABLE supply_orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
  ALTER TABLE supply_messages ADD COLUMN IF NOT EXISTS supplier_id INTEGER
    REFERENCES suppliers(id) ON DELETE SET NULL;

  -- Move every business that was acting as a supplier across to the new model,
  -- once. Businesses keep existing — a wholesaler may well keep its own books —
  -- but the trading relationships and orders now hang off the supplier.
  INSERT INTO suppliers (user_id, name, industry, supply_code, lead_time_days, accepting_orders, created_at)
  SELECT b.user_id, b.name, b.industry, b.supply_code, b.lead_time_days, TRUE, b.created_at
  FROM businesses b
  WHERE b.is_supplier = TRUE
    AND NOT EXISTS (SELECT 1 FROM suppliers s WHERE s.supply_code = b.supply_code);

  INSERT INTO supplier_products (supplier_id, user_id, name, sku, quantity, unit_cost, sale_price)
  SELECT s.id, p.user_id, p.name, p.sku, p.quantity, p.unit_cost, p.sale_price
  FROM products p
  JOIN businesses b ON b.id = p.business_id AND b.is_supplier = TRUE
  JOIN suppliers s ON s.supply_code = b.supply_code
  WHERE NOT EXISTS (
    SELECT 1 FROM supplier_products sp
    WHERE sp.supplier_id = s.id AND lower(sp.name) = lower(p.name)
  );

  UPDATE trade_partners tp
  SET supplier_id = s.id
  FROM businesses b
  JOIN suppliers s ON s.supply_code = b.supply_code
  WHERE tp.supplier_business_id = b.id AND tp.supplier_id IS NULL;

  UPDATE supply_orders o
  SET supplier_id = s.id
  FROM businesses b
  JOIN suppliers s ON s.supply_code = b.supply_code
  WHERE o.supplier_business_id = b.id AND o.supplier_id IS NULL;

  UPDATE supply_order_items i
  SET catalog_product_id = sp.id
  FROM supply_orders o
  JOIN suppliers s ON s.id = o.supplier_id
  JOIN supplier_products sp ON sp.supplier_id = s.id
  WHERE i.order_id = o.id
    AND i.catalog_product_id IS NULL
    AND lower(sp.name) = lower(i.name);

  -- Messages were stamped with the sending business; the supplier's half of a
  -- thread now points at the supplier instead.
  UPDATE supply_messages m
  SET supplier_id = s.id
  FROM businesses b
  JOIN suppliers s ON s.supply_code = b.supply_code
  WHERE m.business_id = b.id AND m.supplier_id IS NULL;

  -- Suppliers are no longer businesses, so the old columns cannot stay required
  -- or keep pointing at businesses(id) — a supplier that was never a business
  -- would fail the constraint. They are kept, nullable and unconstrained, so
  -- migrated rows still show where they came from.
  ALTER TABLE supply_orders ALTER COLUMN supplier_business_id DROP NOT NULL;
  ALTER TABLE trade_partners ALTER COLUMN supplier_business_id DROP NOT NULL;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
               WHERE conname = 'supply_orders_supplier_business_id_fkey') THEN
      ALTER TABLE supply_orders DROP CONSTRAINT supply_orders_supplier_business_id_fkey;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint
               WHERE conname = 'trade_partners_supplier_business_id_fkey') THEN
      ALTER TABLE trade_partners DROP CONSTRAINT trade_partners_supplier_business_id_fkey;
    END IF;
    -- The old uniqueness was per business pair; it is per supplier now.
    IF EXISTS (SELECT 1 FROM pg_constraint
               WHERE conname = 'trade_partners_buyer_business_id_supplier_business_id_key') THEN
      ALTER TABLE trade_partners
        DROP CONSTRAINT trade_partners_buyer_business_id_supplier_business_id_key;
    END IF;
  END $$;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_partners_pair
    ON trade_partners (buyer_business_id, supplier_id);
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

// Each category is inserted on its own if it is missing. Counting first and
// bailing when any exist looked equivalent, but the schema above already adds
// "Loan Payment" — so on a brand-new database that one row made this skip the
// other thirteen, and a fresh install came up with a single category.
async function seedDefaultCategories() {
  let added = 0;

  for (const [name, kind, icon] of DEFAULT_CATEGORIES) {
    const { rowCount } = await pool.query(
      `INSERT INTO categories (user_id, name, kind, icon)
       SELECT NULL, $1, $2, $3
       WHERE NOT EXISTS (
         SELECT 1 FROM categories WHERE user_id IS NULL AND name = $1
       )`,
      [name, kind, icon]
    );
    added += rowCount;
  }

  if (added > 0) {
    console.info(`Seeded ${added} default categor${added === 1 ? "y" : "ies"}`);
  }
}

// Best-effort: reports failure instead of throwing so the app can still boot
// (public pages, in-memory sessions) before PostgreSQL is configured.
//
// The two ways this fails are kept apart deliberately. "No database" is a setup
// problem with a known fix; a schema that will not build is a bug in this file.
// Reporting the second as the first sent a CI failure in entirely the wrong
// direction once — every test failed on a fresh database and the only thing the
// log said was that the database was unavailable, which it was not.
//
// They are told apart in the return value as well as in the log, so a caller
// that has to act differently on each — the integration tests skip for one and
// fail for the other — can read which happened instead of working it out again.
// Returns { ok, reason: "ready" | "unreachable" | "schema", detail }.
export async function ensureSchemaState() {
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    // A refused connection arrives as an AggregateError whose own message is
    // empty — one attempt per address the host resolved to — so the reason has
    // to come out of the list. Without this the commonest failure of the lot,
    // no server running, printed as an empty pair of brackets.
    const reason =
      error.message ||
      error.errors?.map((cause) => cause.message).filter(Boolean).join("; ") ||
      String(error);
    console.warn("Database unavailable — starting without persistence.");
    console.warn(`  (${reason})`);
    console.warn("  Copy .env.example to .env, point it at PostgreSQL, and restart.");
    return { ok: false, reason: "unreachable", detail: reason };
  }

  try {
    await pool.query(SCHEMA_SQL);
    await seedDefaultCategories();
    console.info("Database schema is ready");
    return { ok: true, reason: "ready", detail: "" };
  } catch (error) {
    // We are connected, so this is the schema itself. SCHEMA_SQL is one long
    // batch: the message alone rarely says which statement failed, and these
    // fields are the only way back to it, so print whichever ones are set.
    console.error("Database schema could not be created — starting without persistence.");
    console.error("  The database is reachable, so this is a bug in the schema, not your setup.");
    console.error(`  ${error.message}`);
    for (const [label, value] of [
      ["SQLSTATE", error.code],
      ["detail", error.detail],
      ["hint", error.hint],
      ["where", error.where]
    ]) {
      if (value) {
        console.error(`  ${label}: ${value}`);
      }
    }
    return { ok: false, reason: "schema", detail: error.message };
  }
}

// The boolean form, for callers that only need to know whether persistence is
// available: the app deciding whether to boot, the seed script deciding whether
// to carry on. Both have already had the reason printed for them.
export async function ensureSchema() {
  return (await ensureSchemaState()).ok;
}
