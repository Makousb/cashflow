// Every mutating route here is reached by a form this app itself rendered,
// so a legitimate submission's Origin or Referer, when it sends one at all,
// names this app's own host — the one thing a cross-site form on somebody
// else's page, riding the visitor's cookie, cannot forge. This exists
// beside SameSite=Lax on the session cookie, not instead of it: Lax is what
// actually stops the cross-site cookie in every browser new enough to still
// receive updates, and has done since ~2020. This check is a backstop for
// whatever's left that predates that — which in practice means closer to
// nothing than to "most browsers" now, and shrinking every year.
//
// A synchronizer token (one in every form, checked against the session) is
// the textbook answer and was considered — it touches a form on nearly every
// page in the app rather than one middleware, for coverage this already-
// POST-only app gets most of the value of for a fraction of the diff.
//
// Absence of a usable signal is let through rather than refused — both
// headers missing, or Origin present as the opaque value "null" with no
// Referer to fall back on. Ad blockers and browser privacy features strip
// these on entirely ordinary same-origin submissions (confirmed against two
// real signups on this app: Opera's own privacy features, and a Chrome ad
// blocker that strips both headers at once), and neither header is
// guaranteed by spec. What an attacker's cross-origin form post cannot do is
// forge a Referer that names this app's own host — that stays refused below,
// same as ever.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hostOf(headerValue) {
  try {
    return new URL(headerValue).host;
  } catch {
    // Not a URL at all — some proxies send a bare host in Origin's place.
    // Treat it as the host it already looks like rather than fail closed on a
    // header this permissive by spec.
    return headerValue;
  }
}

export function requireSameOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const origin = req.get("origin");
  const referer = req.get("referer");

  // "null" is the opaque value a sandboxed iframe sends, which is why this
  // used to refuse it outright regardless of Referer — but real, ordinary
  // browsers now produce the exact same value often enough (see above) that
  // treating it as automatically hostile refuses real visitors more often
  // than it catches an attack SameSite=Lax hasn't already stopped. Referer
  // is still checked when one was sent: a same-origin Referer confirms it,
  // and one naming somewhere else is refused same as any other mismatch.
  const sentOrigin = origin === "null" ? referer : origin || referer;
  if (sentOrigin && hostOf(sentOrigin) !== req.get("host")) {
    return res.status(403).render("403", { title: "Blocked" });
  }

  next();
}
