export function notFound(req, res) {
  res.status(404).render("404", {
    title: "Page Not Found"
  });
}

export function handleError(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  // Posting into a closed period is a refusal, not a fault. It reaches here as
  // an exception because it is thrown deep inside a transaction — where a
  // return value would be ignored by half a dozen callers — but a person who
  // dated something wrong should be told so on the page they were on, not shown
  // a server error.
  if (err?.code === "BOOKS_CLOSED" && req.flash) {
    req.flash("error", err.message);
    return res.redirect(req.get("referer") || "/business");
  }

  console.error(err);

  return res.status(500).render("500", {
    title: "Server Error"
  });
}
