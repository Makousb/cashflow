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
  database: {
    host: process.env.DB_HOST,
    port: getOptionalNumber("DB_PORT", undefined),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    name: process.env.DB_NAME,
    ssl: process.env.DB_SSL === "true"
  }
};
