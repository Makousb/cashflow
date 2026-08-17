export function notFound(req, res) {
  res.status(404).render("404", {
    title: "Page Not Found"
  });
}

export function handleError(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  // Some errors are somebody being told no rather than something going wrong:
  // posting into a closed period, or naming a wallet that is not yours. Both
  // reach here as exceptions because they are thrown deep inside a database
  // transaction — where a return value would be ignored by half a dozen
  // callers — but the person should be told on the page they were on rather
  // than shown a server error.
  const refusals = {
    BOOKS_CLOSED: "/business",
    NOT_YOURS: "/dashboard",
    IS_A_TRANSFER: "/transactions"
  };
  if (refusals[err?.code] && req.flash) {
    req.flash("error", err.message);
    return res.redirect(req.get("referer") || refusals[err.code]);
  }

  console.error(err);

  return res.status(500).render("500", {
    title: "Server Error"
  });
}
