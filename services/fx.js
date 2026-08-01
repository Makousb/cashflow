import fs from "fs";
import os from "os";
import path from "path";

// Cache lives in the OS temp dir, not the project tree — otherwise writing it
// would trip `node --watch` and restart the dev server on every refresh.
const CACHE_FILE = path.join(os.tmpdir(), "cashflow-fx-cache.json");

// Rates are always keyed to USD = 1 (units of the currency per 1 USD).
// Bundled snapshot so conversion still works fully offline / before the first
// live fetch — clearly labelled as such so the UI can flag it as stale.
const BUNDLED = {
  base: "USD",
  fetchedAt: "2026-07-01T00:00:00Z",
  source: "bundled",
  rates: {
    USD: 1, KES: 129.5, UGX: 3720, TZS: 2540, RWF: 1330, EUR: 0.877,
    GBP: 0.746, NGN: 1580, ZAR: 18.1, INR: 83.4, AED: 3.6725, CNY: 7.18,
    JPY: 157, CAD: 1.37, AUD: 1.49
  }
};

const SIX_HOURS = 6 * 60 * 60 * 1000;
const PROVIDERS = [
  "https://open.er-api.com/v6/latest/USD",
  "https://api.exchangerate-api.com/v4/latest/USD"
];

// In-memory cache, seeded synchronously at import from the last saved file (if
// any) so the very first request already has usable rates.
let cache = loadFromFile() || BUNDLED;
let refreshing = null;

function loadFromFile() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.rates && parsed.rates.USD === 1) {
      return parsed;
    }
  } catch {
    // No cache file yet — fine, we fall back to the bundled snapshot.
  }
  return null;
}

function saveToFile(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.warn(`FX: could not cache rates to disk: ${error.message}`);
  }
}

function isStale() {
  const age = Date.now() - new Date(cache.fetchedAt).getTime();
  return cache.source === "bundled" || Number.isNaN(age) || age > SIX_HOURS;
}

async function fetchFromProvider(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const rates = json.rates;
    if (!rates || typeof rates.USD === "undefined") {
      throw new Error("unexpected response shape");
    }
    return {
      base: "USD",
      fetchedAt: new Date().toISOString(),
      source: new URL(url).host,
      rates
    };
  } finally {
    clearTimeout(timer);
  }
}

// Refresh live rates. De-duped so concurrent callers share one in-flight fetch.
export function refreshRates(force = false) {
  if (!force && !isStale()) {
    return Promise.resolve(cache);
  }
  if (refreshing) {
    return refreshing;
  }
  refreshing = (async () => {
    for (const url of PROVIDERS) {
      try {
        const fresh = await fetchFromProvider(url);
        cache = fresh;
        saveToFile(fresh);
        return fresh;
      } catch (error) {
        console.warn(`FX: ${new URL(url).host} failed (${error.message})`);
      }
    }
    // All providers failed — keep whatever we already had.
    return cache;
  })();
  try {
    return refreshing;
  } finally {
    refreshing.finally(() => {
      refreshing = null;
    });
  }
}

export function getRatesInfo() {
  return {
    fetchedAt: cache.fetchedAt,
    source: cache.source,
    stale: isStale()
  };
}

// Units of `to` per 1 unit of `from`. Unknown currencies fall back to 1.
export function getRate(from, to) {
  if (from === to) return 1;
  const f = cache.rates[from];
  const t = cache.rates[to];
  if (!f || !t) return 1;
  return t / f;
}

export function convert(amount, from, to) {
  return (Number(amount) || 0) * getRate(from, to);
}

// Convert an amount the user typed (in their display currency) back into the
// base currency it's stored in, rounded to cents.
export function toBase(user, displayAmount) {
  const base = user?.base_currency || user?.currency || "USD";
  const display = user?.currency || base;
  return Number(convert(displayAmount, display, base).toFixed(2));
}
