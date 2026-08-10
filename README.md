<img src="public/img/logo-wordmark.svg" alt="Cashflow" height="52" />

[![CI](https://github.com/Makousb/cashflow/actions/workflows/ci.yml/badge.svg)](https://github.com/Makousb/cashflow/actions/workflows/ci.yml)

A personal budgeting and financial planning web app. Track expenses and income
across multiple wallets, set monthly budgets per category, and grow savings
goals — inspired by apps like Frugal (Blueberry Projects).

Two services work together: a **Node.js web app** (Express + EJS) that owns the
UI, auth, and database, and a **Python analytics service** (FastAPI) that
computes the insights behind the Reports page — spending forecasts, category
breakdowns, and plain-English observations, charted in the browser with
JavaScript (Chart.js).

## Three sides, one app

Signing up asks what you are here for, and that decides where you land:

- **Personal** — your own money: wallets, budgets, goals, loans, credit,
  receipts.
- **Business** — a small business's books: bookkeeping, statements, stock,
  sales, payroll, tax, supply chain, marketing and the accounting agent.
- **Supplier** — selling to businesses: a catalog, a trade code buyers connect
  with, and the orders they place. A supplier keeps no books here; an order
  records what it is worth and whether it has been paid.

It is a starting point rather than a partition. One login can hold a personal
side, any number of businesses and any number of supplier accounts — the type
just decides the front door.

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
  (weekly/monthly/yearly) and Cashflow records them automatically when they
  come due, catching up any missed occurrences; pause or delete anytime
- **Loan tracking & payoff plans** — track each loan's balance, total paid, and
  the interest accruing on it. Logging a payment also posts it to the ledger as
  an expense (in a "Loan Payment" category) and deducts the wallet you paid
  from. The payoff planner (Python analytics service) looks at your monthly
  spending, flags over-budget and discretionary categories to trim, and builds
  an avalanche repayment schedule showing your debt-free date and the interest
  you'd save versus paying only the minimums
- **Credit — day loans, purchase plans, and a secured card** — apply for credit
  from the personal side. Every answer is worked out from your own ledger: what
  comes in, what goes out, and what you have already promised elsewhere in the
  app. There is no bureau behind it and no lender — the point is that a decline
  names the figure that caused it rather than just saying no, and every
  application is kept, refused ones included, because the reason is the useful
  part
  - **Day loan** — a small amount for 7, 14 or 30 days, repaid in one go. It
    costs 1% of the amount for each week it is held, is capped at half a month's
    income, and is refused if repaying it would not fit in what you have spare.
    Approval pays the money into a wallet and books it in the ledger
  - **Pay in instalments** — split a purchase over 3, 4 or 6 equal monthly
    payments at no interest. An instalment may not take more than a quarter of
    what is spare, and plans cannot stack past a month's income. Nothing leaves
    your wallet until an instalment falls due; each one posts as an expense when
    it is paid
  - **Secured card** — a limit equal to a deposit you put up yourself, so there
    is no minimum: a small deposit simply buys a small card. Spend against it up
    to the limit, and a balance carried past the end of a month is charged
    interest — clear it inside the month and it costs nothing. A statement is
    drawn each month asking for a twentieth of the balance, never less than that
    month's interest, so paying the minimum always leaves the debt smaller than
    it was. It falls due 21 days later, and missing it adds a fee of a tenth of
    whatever was short. Closing the card returns the deposit, once the balance
    is clear — the deposit secures the card rather than settling it
  - **Reminders** — an email three days before the minimum falls due, and
    another if the date goes by unpaid, each sent once per statement. They go
    from the dashboard as well as the credit page, since somebody who has
    stopped opening the card is who they are for
  - **A report for the year** — what you owe now and on what, how many payments
    arrived on time and how many did not, what the borrowing cost you in fees,
    interest and late fees, your biggest purchases (from a wallet and on the
    card alike), and the category that took the most. It carries a standing out
    of 100, deliberately not on the 300-850 scale a bureau uses, because it is
    not a bureau score: it is worked out from what you have done in this app and
    nothing else, and no bureau is asked about you. Nobody outside sees it
    unless you choose to show them — see below. Every point is attributed, so it
    says which part is holding the number back.
    Settling credit is left out of the spending figures throughout — paying a
    card off is not a category you spent money on, it is paying for spending
    already counted where it happened
  - **Showing a lender** — for borrowing this app does not do: a mortgage, a
    car, a business loan. It works from either end. You can make a check for a
    named lender and hand them the link; or you give them your credit code and
    they send a request, which sits on your credit page until you approve or
    turn it down. Either way consent is the whole mechanism — a code only lets
    somebody ask, nothing is shown until you say yes, and a request that is
    turned down shows them nothing but the no. A code that belongs to nobody is
    answered exactly like one that does, so the request form cannot be used to
    find out who banks here. A check runs out on a date you
    set (90 days at the outside), you can stop it at any moment, and every time
    it is opened is counted back to you. What it shows is the credit standing
    and nothing else: not what you spend or what on, not your balances, not
    individual purchases, not your contact details, and not even what you called
    an account — a lender deciding on a mortgage needs to know whether debts get
    paid, not what the groceries cost
- **Business** — a separate area for running a business's books apart from your
  personal money, with modules on the business dashboard:
  - **Bookkeeping** — record income and expenses by category and track live
    profit & loss (revenue, expenses, net profit, margin, and an expense
    breakdown)
  - **Financial statements** — a structured income statement (revenue, COGS,
    gross profit, operating expenses, net profit), a balance sheet (assets,
    liabilities, owner's equity), and a cash flow statement. The income
    statement is accrual: buying stock isn't a cost, it swaps cash for an
    asset, and that stock becomes a cost only once it sells. Cost of goods sold
    is derived as stock purchased less stock still on hand, and the statement
    shows both lines so the figure can be checked rather than taken on trust.
    Cash flow stays cash basis, so a stock purchase appears there in full — the
    page explains the gap between the two
  - **Invoices (accounts receivable)** — track money customers owe you; marking
    an invoice paid records the income
  - **Bills (accounts payable)** — track vendor bills you owe; marking a bill
    paid records the expense
  - **Accountant** — an agent that closes the books. It reads every entry,
    invoice, bill, product and sale, works the tax position out from the accrual
    profit, and reports what it would fix: entries with no real category,
    duplicate postings clustered rather than listed pair by pair, overdue money
    in both directions, stock priced at or below cost, sales made at a loss,
    months with no bookkeeping at all, and categories spending well above their
    own average. It proposes; you apply. Every figure is computed in code — the
    optional AI writes the covering note and suggests a category for loose
    entries, and its suggestions are checked against the business's own category
    list before they can touch a row. Without an AI provider configured it still
    does all of it, and writes the note itself. It can also close the books on
    its own once a calendar month, and email the close to whoever you nominate —
    which can be a bookkeeper with no login here. Configure SMTP to switch that
    on; without it the close still runs and simply records that it told nobody. Switch on the monthly close and
    it runs itself: the first time anyone opens the business after the month
    turns, the books are closed for that month. Skipped months are not caught up
    — a review is a snapshot of the books as they stand, so three identical ones
    would only be noise
  - **Marketing** — funnels, a contact list and promotions. It drafts a landing
    page from what you actually sell and publishes it at a public URL; anyone
    who fills the form in becomes a contact, with the moment and manner of
    their consent recorded. Contacts move themselves through lead → engaged →
    customer → lapsed based on whether they have been written to and whether
    they have bought, and each one has a timeline of everything that happened.
    Promotions are drafted for a chosen segment and sent only when you send
    them.
    Consent is enforced in the schema, not the interface: the audience query
    cannot return someone who has unsubscribed, every promotion carries a
    one-click unsubscribe link that needs no account, re-entering an address
    does not undo an unsubscribe, and an unknown segment reaches nobody rather
    than everybody. The AI writes the copy; it never chooses a recipient
  - **Advisor** — a chat assistant that answers questions about the business
    (profit, cash, costs to cut, tax, receivables, inventory, payroll) grounded
    in its actual figures. Works out of the box with built-in insights; point
    the optional `AI_*` settings at any standard chat-completions API for
    open-ended conversation
  - **Sales** — sell from stock: pick items and quantities, and the units come
    off the shelf while the money is booked. Each line captures what those
    particular units cost, so you see the margin a sale actually earned rather
    than an estimate. Sells on credit raise an invoice instead of booking income
    (it posts when the invoice is paid), off-catalog lines cover services that
    don't touch inventory, overselling is refused with the shortfall named, and
    voiding a sale puts the stock back and unbooks the money
  - **Inventory & ordering** — track products, stock levels, and stock value;
    get low-stock alerts; raise purchase orders (one click reorders everything
    low), then receive them to add stock and post the cost to the ledger
  - **Payroll** — manage employees (monthly or hourly, with deductions), run
    payroll for a period to generate payslips (gross, deductions, net), and
    post the wage bill to the business ledger
  - **Tax preparation** — estimate income tax from your profit (configurable
    rate) plus payroll deductions to remit, then set money aside toward the
    bill and track your coverage
  - **Budgeting & planning** — set a monthly revenue target and per-category
    expense budgets, track this month's actuals against them, and project a
    six-month cash-flow forecast from your run rate
  - **Supply chain** — trade with other businesses inside Cashflow. Share your
    connection code to let buyers find you, publish your products as a catalog,
    and order from your own suppliers' catalogs (quantities pre-filled for
    anything you're low on). Orders walk a two-sided workflow — placed,
    confirmed with a committed date, shipped, delivered, received — where
    shipping deducts the supplier's stock and raises their invoice, and
    receiving stocks the buyer's inventory and raises the bill in payables.
    Each order carries a live chat thread, and both sides see status changes and
    messages the moment they happen (Server-Sent Events, no polling). Delivery
    dates are estimated from the supplier's stated lead time, then from what
    they actually deliver once there's history
  - **Supply chain reports** — supplier scorecards (orders, spend, on-time
    delivery, average lead time), open commitments, late orders, monthly
    ordering trend, and what you buy and sell most — with a selling-side view of
    the same numbers when you supply others

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
   CREATE DATABASE cashflow;
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

6. Optionally, fill it with a worked example:

   ```bash
   npm run seed
   ```

   This creates a demo account — **demo@cashflow.local / growmoney123** — with
   three months of personal finances plus two trading businesses: a grocer with
   books, stock, sales, payroll, tax and budgets, and the wholesaler that
   supplies it, complete with delivered orders and one still in flight. Handy
   for seeing every feature without typing anything in.

   Everything hangs off that one account, so deleting the user removes all of
   it. `npm run seed:reset` rebuilds it from scratch. Dates are relative to the
   day you run it, so the demo never looks stale. The seed refuses to run when
   `NODE_ENV=production`, since the password above is public.

> Without a database configured the app still boots in a read-only demo mode:
> public pages render, but nothing is persisted and you can't sign up.
> Without the analytics service, everything except the Reports page works.

## Tests

```bash
npm test          # everything
npm run test:unit # just the fast ones, no database needed
npm run check     # parse every source file and view without running them
```

Built on Node's own test runner, so there are no testing dependencies to
install.

The **unit tests** cover the arithmetic the app is judged on: how cost of goods
sold is derived, what a delivery estimate does with a supplier's history, how a
month-end recurring date clamps into February, payslip rounding, loan interest
and payoff projection, which credit application the figures allow and why a
refused one was refused, what a card owes after a month of interest and a missed
minimum, and currency formatting.

One of the integration tests starts the app on an ephemeral port and requests
every page. `npm run check` parses files but cannot see a missing import — the
module loads and only fails when the route is hit — and that shipped a broken
dashboard once while every other test stayed green.

The rest of the **integration tests** run against a real PostgreSQL and exercise
the query layer directly — selling stock, refusing to oversell, voiding a sale back out
again, an order moving from placed to received across two businesses, the ledger
feeding the statements, and a card charged, paid down and reminded about. Each
builds its own throwaway user and deletes it afterwards, so they leave nothing
behind. Without a database configured they
skip rather than fail, so `npm test` works on a fresh clone.

`npm run check` parses every `.js` and compiles every `.ejs` without executing
anything. The schema is a single long template literal, so one stray backtick in
an SQL comment breaks the file in a way nothing notices until the app won't
boot — this catches that class of mistake, and unclosed tags in views.

CI runs all of it on every push and twice a day on a schedule, plus a
from-scratch install against an empty database. A first install is its own code
path, and it is where the last two schema bugs were hiding. The Python service
has its own tests now as well, run in the job that imports it.

It runs the whole suite three times over: in UTC, and in a zone either side of
it — UTC+14 and UTC−11 — with the database put on the same clock as the runner
each time. A date built the wrong way round is only wrong when the two disagree
about which day it is, and on a UTC runner they never can. That is how a test
that failed between midnight and 3am on a machine east of UTC passed here every
time, for as long as it took to notice. Between the two non-UTC legs there is no
hour of the day when at least one of them is not on a date UTC disagrees with,
so the mistake now fails on every run rather than on some of them.

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
cashflow/
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
├── services/               # Analytics & FX clients, live-update hub
├── views/                  # EJS templates (+ shared partials)
├── public/                 # Static assets (css, client-side js, charts)
└── utils/                  # Currency & date formatting helpers
```
