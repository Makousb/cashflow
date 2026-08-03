import "dotenv/config";

const isProduction = process.env.NODE_ENV === "production";

function getOptionalNumber(name, fallback) {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsedValue = Number.parseInt(value, 10);
  return Number.isNaN(parsedValue) ? fallback : parsedValue;
}

// Render's `fromService … property: hostport` hands us "host:port" with no
// scheme; internal service traffic is plain HTTP.
function normalizeAnalyticsUrl(value) {
  if (!value) {
    return "http://localhost:8000";
  }
  return /^https?:\/\//.test(value) ? value : `http://${value}`;
}

function getSessionSecret() {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }

  if (isProduction) {
    throw new Error("SESSION_SECRET is required in production.");
  }

  return "development-session-secret-change-me";
}

export const config = {
  env: process.env.NODE_ENV || "development",
  isProduction,
  // 3001 by default so Cashflow can run alongside other local apps on 3000.
  port: getOptionalNumber("PORT", 3001),
  sessionSecret: getSessionSecret(),
  // Python FastAPI service that computes the Reports page insights.
  analyticsUrl: normalizeAnalyticsUrl(process.env.ANALYTICS_URL),
  // Optional AI provider for the business advisor. Any standard chat-completions
  // endpoint works; without it the advisor falls back to built-in insights.
  ai: {
    apiKey: process.env.AI_API_KEY || "",
    baseUrl: process.env.AI_BASE_URL || "",
    model: process.env.AI_MODEL || ""
  },
  // Outgoing mail. Without a host nothing is sent and nothing fails — the
  // monthly close simply records that it notified nobody. SMTP rather than one
  // vendor's HTTP API, because every provider speaks it.
  mail: {
    host: process.env.SMTP_HOST || "",
    port: getOptionalNumber("SMTP_PORT", 587),
    user: process.env.SMTP_USER || "",
    password: process.env.SMTP_PASSWORD || "",
    // Port 465 is implicit TLS; 587 upgrades with STARTTLS.
    secure: process.env.SMTP_SECURE === "true",
    from: process.env.MAIL_FROM || "Cashflow <no-reply@cashflow.local>"
  },
  // Used to link back into the app from an email.
  appUrl: (process.env.APP_URL || "").replace(/\/$/, ""),
  database: {
    host: process.env.DB_HOST,
    port: getOptionalNumber("DB_PORT", undefined),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    name: process.env.DB_NAME,
    ssl: process.env.DB_SSL === "true"
  }
};
