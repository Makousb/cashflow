import express from "express";
import flash from "connect-flash";
import helmet from "helmet";
import path from "path";
import pgSession from "connect-pg-simple";
import session from "express-session";
import { fileURLToPath } from "url";

import { config } from "./config/env.js";
import { pool } from "./db/index.js";
import { ensureSchema } from "./db/ensureSchema.js";
import { handleError, notFound } from "./middlewares/error.middleware.js";
import accountRoutes from "./routes/accounts.js";
import authRoutes from "./routes/auth.js";
import budgetRoutes from "./routes/budgets.js";
import businessRoutes from "./routes/business.js";
import supplierRoutes from "./routes/supplier.js";
import dashboardRoutes from "./routes/dashboard.js";
import goalRoutes from "./routes/goals.js";
import loanRoutes from "./routes/loans.js";
import publicRoutes from "./routes/public.js";
import receiptRoutes from "./routes/receipts.js";
import recurringRoutes from "./routes/recurring.js";
import reportRoutes from "./routes/reports.js";
import settingsRoutes from "./routes/settings.js";
import transactionRoutes from "./routes/transactions.js";
import { formatCurrency } from "./utils/currency.js";
import { DEFAULT_CURRENCY } from "./utils/currencies.js";
import { formatDate } from "./utils/dates.js";
import { convert, getRate, getRatesInfo, refreshRates } from "./services/fx.js";

const app = express();
const PgSession = pgSession(session);
const __filename = fileURLToPath(import.meta.url);
const appRoot = path.dirname(__filename);

// Best-effort: when PostgreSQL isn't configured yet the app still boots so
// public pages render; sessions fall back to the in-memory store.
const dbReady = await ensureSchema();

app.set("view engine", "ejs");
app.set("views", path.join(appRoot, "views"));

// Behind a single reverse proxy in production (Render/Heroku/nginx) so secure
// cookies are detected correctly.
app.set("trust proxy", config.isProduction ? 1 : false);

// Security headers. CSP is left off while views still use inline <script>
// blocks; re-enable it once those are externalized.
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(appRoot, "public")));

app.use(
  session({
    name: "cashflow.sid",
    store: dbReady
      ? new PgSession({
          pool,
          tableName: "session",
          createTableIfMissing: true
        })
      : undefined,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24,
      sameSite: "lax",
      secure: config.isProduction
    }
  })
);

app.use(flash());

app.use((req, res, next) => {
  const user = req.session.user;
  // Amounts are stored in the user's base currency; everything is shown in
  // their display currency, converted at the current live rate.
  const base = user?.base_currency || user?.currency || DEFAULT_CURRENCY;
  const display = user?.currency || DEFAULT_CURRENCY;

  // Keep rates warm without blocking the request.
  refreshRates().catch(() => {});

  res.locals.currentUser = user || null;
  res.locals.success = req.flash("success");
  res.locals.error = req.flash("error");
  res.locals.dbReady = dbReady;
  res.locals.currentPath = req.path;
  res.locals.formatCurrency = formatCurrency;
  res.locals.formatDate = formatDate;

  res.locals.baseCurrency = base;
  res.locals.displayCurrency = display;
  res.locals.fxRate = getRate(base, display); // display units per 1 base unit
  res.locals.ratesInfo = getRatesInfo();
  // Convert a stored (base) amount to the display currency and format it.
  res.locals.money = (amount) => formatCurrency(convert(amount, base, display), display);
  // Plain converted number (no symbol) for pre-filling amount inputs.
  res.locals.toDisplayNumber = (amount) =>
    Number(convert(amount, base, display).toFixed(2));
  next();
});

app.use("/", publicRoutes);
app.use("/auth", authRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/transactions", transactionRoutes);
app.use("/recurring", recurringRoutes);
app.use("/budgets", budgetRoutes);
app.use("/goals", goalRoutes);
app.use("/loans", loanRoutes);
app.use("/receipts", receiptRoutes);
app.use("/reports", reportRoutes);
app.use("/accounts", accountRoutes);
app.use("/business", businessRoutes);
app.use("/supplier", supplierRoutes);
app.use("/settings", settingsRoutes);

app.use(notFound);
app.use(handleError);

// Exported so tests can start it on an ephemeral port. Importing this file
// must not open a socket, hence the guard: `node app.js` runs it, `import` does
// not.
export default app;

if (process.env.CASHFLOW_NO_LISTEN !== "1") {
  app.listen(config.port, () => {
    console.info(`Cashflow running on http://localhost:${config.port}`);
  });
}
