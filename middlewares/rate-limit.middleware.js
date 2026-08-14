// Login and registration had nothing between a guess and the next one —
// bcrypt's own ~100ms is the only cost an attacker pays, nowhere near enough
// against a patient or distributed attempt at a password list. No dependency
// for this: a fixed-window counter in memory is the whole of what
// express-rate-limit would give here, and this app already keeps state this
// way (services/fx.js's cache, services/realtime.js's subscribers).
//
// Two keys, not one. An IP limit alone lets an attacker who is not IP-limited
// (many source addresses) grind one victim's password from all sides; an
// email limit alone lets one source grind through many accounts as long as it
// spreads its guesses out. Login checks both; registration, which has no
// "account" to protect, checks only the IP.

const buckets = new Map();

// Old entries are only ever overwritten by a key being checked again — an
// attacker using a new IP for every attempt would otherwise grow this map
// forever. Swept on an interval instead, since nothing about this being
// memory-only depends on the sweep having run: a restart clears it anyway.
const SWEEP_MS = 10 * 60 * 1000;
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, SWEEP_MS);
sweep.unref();

// True once too many attempts have already landed in the current window;
// counts this one as it goes, so the check and the increment are the same
// call and nothing can slip through between them.
function tooMany(key, { max, windowMs }) {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }

  bucket.count += 1;
  return bucket.count > max;
}

// 10 tries per 15 minutes is generous for someone who mistyped a password
// twice, and slow going for a list of thousands.
const LOGIN_MAX = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function limitLogin(req, res, next) {
  const email = (req.body.email || "").trim().toLowerCase();
  const ip = req.ip;

  if (tooMany(`login:ip:${ip}`, { max: LOGIN_MAX, windowMs: LOGIN_WINDOW_MS })) {
    req.flash("error", "Too many attempts from here — wait a few minutes and try again.");
    return res.redirect("/auth/login");
  }

  // An empty email cannot be a targeted account, and would otherwise let
  // every blank submission share one bucket with everyone else's.
  if (email && tooMany(`login:email:${email}`, { max: LOGIN_MAX, windowMs: LOGIN_WINDOW_MS })) {
    req.flash("error", "Too many attempts on this account — wait a few minutes and try again.");
    return res.redirect("/auth/login");
  }

  next();
}

// Registration spam is a nuisance rather than a way into someone else's
// money, so the same window is looser and IP-only — there is no account yet
// to key a second bucket on.
const REGISTER_MAX = 20;
const REGISTER_WINDOW_MS = 15 * 60 * 1000;

export function limitRegister(req, res, next) {
  if (tooMany(`register:ip:${req.ip}`, { max: REGISTER_MAX, windowMs: REGISTER_WINDOW_MS })) {
    req.flash("error", "Too many attempts from here — wait a few minutes and try again.");
    return res.redirect("/auth/register");
  }

  next();
}
