// Every mutating route here is reached by a form this app itself rendered,
// so a legitimate submission always carries an Origin (or, failing that, a
// Referer) whose host is this app's own — the one thing a cross-site form on
// somebody else's page, riding the visitor's cookie, cannot forge. This is
// what stands behind SameSite=Lax on the session cookie rather than
// instead of it: Lax already blocks the cross-site cookie for any modern
// browser, and this catches the same class of request a browser too old to
// enforce SameSite would still let through.
//
// A synchronizer token (one in every form, checked against the session) is
// the textbook answer and was considered — it touches a form on nearly every
// page in the app rather than one middleware, for coverage this already-
// POST-only app gets most of the value of for a fraction of the diff.
//
// Absence of both headers is let through rather than refused. Some browsers
// and privacy extensions strip Referer, and neither header is guaranteed by
// spec — refusing on "missing" would occasionally refuse a real visitor doing
// nothing wrong, while an attacker's cross-origin form post cannot make the
// browser omit Origin; it can only ever be absent or genuine, never forged.
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

  const sentOrigin = req.get("origin") || req.get("referer");

  // The literal string "null", not a missing header — browsers send exactly
  // this from a sandboxed iframe, a cross-origin redirect, or a file:// page.
  // It is tempting to treat it like the missing-header case above and let it
  // through, and this app happens to have no legitimate reason to ever be
  // framed — but a sandboxed iframe with nothing more than `allow-forms` is
  // also precisely how an attacker gets a browser to send this, on command,
  // as their whole way past a naive Origin check. Absent is inconclusive;
  // "null" is a specific, attacker-reachable value, and OWASP's own CSRF
  // guidance is explicit that the two must not be handled the same way.
  // (This is also what blocked a real submission from this project's own
  // preview tool during development — it renders pages sandboxed, so every
  // POST from it carries this exact header. That is a limitation of
  // verifying through that tool, not a reason to weaken this.)
  if (sentOrigin && (sentOrigin === "null" || hostOf(sentOrigin) !== req.get("host"))) {
    return res.status(403).render("403", { title: "Blocked" });
  }

  next();
}
