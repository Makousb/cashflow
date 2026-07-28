# 🌳 MoneyTree

A personal budgeting and financial planning web app. Track expenses and income
across multiple wallets, set monthly budgets per category, and grow savings
goals — inspired by apps like Frugal (Blueberry Projects).

Two services work together: a **Node.js web app** (Express + EJS) that owns the
UI, auth, and database, and a **Python analytics service** (FastAPI) that
computes the insights behind the Reports page — spending forecasts, category
breakdowns, and plain-English observations, charted in the browser with
JavaScript (Chart.js).

## Features

- **Expense & income tracking** — quick entry with categories, notes, and dates
- **Multiple accounts (wallets)** — cash, bank, mobile money, credit card;
  balances update automatically as transactions are recorded
- **Monthly budgets** — set a limit per expense category and watch a progress
  bar fill (and turn red when you overshoot)
- **Savings goals** — name a target, contribute over time, track progress
- **Dashboard** — this month's income, expenses, and net at a glance, plus
  recent activity, budget health, and goal progress
- **Choose your currency, with live FX** — your account is kept in a base
  currency (Kenyan Shilling by default), and you can view it in any other
  currency converted at live exchange rates. Rates are fetched from a free
  provider and cached (with an offline fallback); amounts entered while viewing
  a foreign currency are converted back to the base on save, so stored data
  never drifts. Nothing is ever moved — conversion is display only
- **Reports & insights** — income vs expense trends, spending by category,
  month-end forecasts, and budget/goal observations computed by the Python
  analytics service and rendered as interactive charts
- **Budget burn-rate alerts** — when a category's spending pace projects past
  its budget, an alarm banner (on the dashboard, budgets, and reports pages)
  shows the projected month-end amount and translates the overage into goal
  impact: how much monthly goal funding it eats and how many months late each
  savings goal would land
- **Receipt scanning** — photograph a receipt (the upload opens the camera on
  mobile) and the analytics service OCRs it with Tesseract, extracts the
  merchant, date, total, and line items, and suggests a category; you review
  and save it as an expense with the photo attached
- **Shopping patterns** — receipts feed the Reports page with frequent
  purchases, repeat merchants (visit cadence and average spend), weekday
  spending concentration, and same-day category correlations
- **Recurring transactions** — schedule rent, salary, or subscriptions once
  (weekly/monthly/yearly) and MoneyTree records them automatically when they
  come due, catching up any missed occurrences; pause or delete anytime
- **Loan tracking & payoff plans** — track each loan's balance, total paid, and
  the interest accruing on it. Logging a payment also posts it to the ledger as
  an expense (in a "Loan Payment" category) and deducts the wallet you paid
  from. The payoff planner (Python analytics service) looks at your monthly
  spending, flags over-budget and discretionary categories to trim, and builds
  an avalanche repayment schedule showing your debt-free date and the interest
  you'd save versus paying only the minimums
- **Business** — a separate area for running a business's books apart from your
  personal money, with modules on the business dashboard:
  - **Bookkeeping** — record income and expenses by category and track live
    profit & loss (revenue, expenses, net profit, margin, and an expense
    breakdown)
  - **Inventory & ordering** — track products, stock levels, and stock value;
    get low-stock alerts; raise purchase orders (one click reorders everything
    low), then receive them to add stock and post the cost to the ledger
  - **Payroll** — manage employees (monthly or hourly, with deductions), run
    payroll for a period to generate payslips (gross, deductions, net), and
    post the wage bill to the business ledger
  - **Tax preparation** — estimate income tax from your profit (configurable
    rate) plus payroll deductions to remit, then set money aside toward the
    bill and track your coverage
  - Budgeting is a planned module shown on the dashboard

### Roadmap

- Custom categories
- CSV export
- Transfers between accounts

## Tech stack

- **Backend:** Node.js, Express 5 (ES modules), multer for photo uploads
- **Analytics:** Python 3.12, FastAPI + Uvicorn (separate microservice),
  Tesseract OCR via pytesseract for receipt reading
- **Views:** EJS server-rendered templates + Chart.js on the client
- **Database:** PostgreSQL (schema auto-created on boot)
- **Auth:** session-based with bcrypt password hashing

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a PostgreSQL database:

   ```sql
   CREATE DATABASE moneytree;
   ```

3. Configure the environment:

   ```bash
   cp .env.example .env
   # then edit .env with your PostgreSQL credentials
   ```

4. Set up the Python analytics service (one-time):

   ```bash
   cd analytics
   python -m venv .venv
   .venv\Scripts\activate        # Windows (macOS/Linux: source .venv/bin/activate)
   pip install -r requirements.txt
   ```

   For receipt scanning, also install the Tesseract OCR engine
   (`winget install UB-Mannheim.TesseractOCR` on Windows,
   `apt install tesseract-ocr` / `brew install tesseract` elsewhere).
   Without it, everything else works — receipt uploads just ask for manual
   entry instead of auto-filling.

5. Run everything with one command:

   ```bash
   npm run dev
   ```

   This starts both services in one terminal — the web app on
   http://localhost:3001 (auto-restarting on file changes) and the analytics
   service on http://localhost:8000. Ctrl+C stops both. They can also be run
   separately: `npm start` (web only) or `npm run analytics` (Python only).

   Tables and default categories are created automatically on first boot.
   Interactive API docs for the analytics service are at
   http://localhost:8000/docs.

> Without a database configured the app still boots in a read-only demo mode:
> public pages render, but nothing is persisted and you can't sign up.
> Without the analytics service, everything except the Reports page works.

## Deployment

`render.yaml` is a [Render](https://render.com) blueprint that provisions
everything in one click: the Node web app, the Python analytics service (built
from `analytics/Dockerfile`, which bundles the Tesseract OCR engine), and a
PostgreSQL database, all wired together.

In the Render dashboard: **New → Blueprint**, pick this repo, and **Apply**.
The web app generates its own `SESSION_SECRET`, reads `DATABASE_URL` from the
provisioned database, and bootstraps its schema on first boot — no manual
setup needed.

## Project structure

```
moneytree/
├── app.js                  # Express app: middleware, sessions, routes
├── analytics/
│   ├── app.py              # FastAPI analytics service (insights, forecasts)
│   └── requirements.txt    # Python dependencies
├── config/env.js           # Environment variable loading & defaults
├── db/
│   ├── index.js            # PostgreSQL connection pool
│   ├── ensureSchema.js     # Schema creation + default category seed
│   └── queries/            # One module per table (users, accounts, ...)
├── middlewares/            # Auth guard, error handlers
├── routes/                 # Thin routers, one per feature area
├── controllers/            # Request handlers, one per feature area
├── services/               # Clients for external services (analytics)
├── views/                  # EJS templates (+ shared partials)
├── public/                 # Static assets (css, client-side js, charts)
└── utils/                  # Currency & date formatting helpers
```
