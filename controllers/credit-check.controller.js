import {
  approveRequest,
  createCheck,
  createRequest,
  denyRequest,
  ensureCreditCode,
  findByCreditCode,
  getCheckByToken,
  getRequestByToken,
  listCheckViews,
  listChecks,
  listRequests,
  recordCheckView,
  revokeCheck
} from "../db/queries/credit-checks.js";
import { config } from "../config/env.js";
import { creditHistoryFor } from "./credit.controller.js";
import {
  checkStatus,
  DEFAULT_DAYS,
  isUsable,
  MAX_DAYS,
  PURPOSES,
  sharedHistory
} from "../utils/credit-check.js";
import { today } from "../utils/dates.js";

const baseUrl = () => config.appUrl || `http://localhost:${config.port}`;

export async function showChecksPage(req, res, next) {
  try {
    const userId = req.session.user.id;
    const [checks, requests, code] = await Promise.all([
      listChecks(userId),
      listRequests(userId),
      ensureCreditCode(userId)
    ]);
    const todayIso = today();

    const withStatus = await Promise.all(
      checks.map(async (check) => ({
        ...check,
        status: checkStatus(check, todayIso),
        url: `${baseUrl()}/credit-check/${check.token}`,
        recentViews: check.views > 0 ? await listCheckViews(check.id, 5) : []
      }))
    );

    res.render("credit-checks", {
      title: "Share your credit history",
      code,
      requests,
      pending: requests.filter((r) => r.status === "pending"),
      requestUrl: `${baseUrl()}/credit-check/request`,
      checks: withStatus,
      purposes: PURPOSES,
      defaultDays: DEFAULT_DAYS,
      maxDays: MAX_DAYS,
      today: todayIso
    });
  } catch (error) {
    next(error);
  }
}

export async function addCheck(req, res, next) {
  const lender = (req.body.lender || "").trim().slice(0, 120);
  const purpose = String(req.body.purpose || "");
  const days = Number.parseInt(req.body.days, 10);
  const amount = Number.parseFloat(req.body.amountSought);

  if (!lender) {
    req.flash("error", "Say which lender this is for.");
    return res.redirect("/credit/checks");
  }
  if (!PURPOSES[purpose]) {
    req.flash("error", "Choose what the borrowing is for.");
    return res.redirect("/credit/checks");
  }

  try {
    const check = await createCheck({
      userId: req.session.user.id,
      lender,
      purpose,
      amountSought: Number.isFinite(amount) && amount > 0 ? amount : null,
      // Clamped rather than refused: a number outside the range is a slip, and
      // the safe end of it is the shorter one.
      days: Number.isInteger(days) && days > 0 ? Math.min(days, MAX_DAYS) : DEFAULT_DAYS
    });

    req.flash(
      "success",
      `Check created for ${lender}. It works until ${check.expires_on}, and you can stop it before then.`
    );
    return res.redirect("/credit/checks");
  } catch (error) {
    return next(error);
  }
}

export async function stopCheck(req, res, next) {
  try {
    const stopped = await revokeCheck(Number(req.params.id), req.session.user.id);
    req.flash(
      stopped ? "success" : "error",
      stopped
        ? "Stopped. Anyone opening that link now sees nothing."
        : "That check is not here, or was stopped already."
    );
    return res.redirect("/credit/checks");
  } catch (error) {
    return next(error);
  }
}

// The lender's side. No account, no login — the token is the whole of the
// authority, which is why it is the only thing that decides what happens here.
//
// One answer covers a token that never existed, one that has run out and one
// that was stopped: a page that distinguishes them tells whoever is holding a
// dead link something about somebody who did not choose to tell them.
export async function showCheck(req, res, next) {
  try {
    const check = await getCheckByToken(String(req.params.token || ""));
    const todayIso = today();

    if (!check || !isUsable(check, todayIso)) {
      return res.status(404).render("credit-check-gone", {
        title: "Credit check unavailable"
      });
    }

    // Recorded before the page is built, so the owner's record of who looked
    // does not depend on the rendering going well.
    await recordCheckView(check.id);

    const { facilities, monthlyIncome, owner } = await creditHistoryFor(check.user_id, todayIso);
    const history = sharedHistory({ facilities, monthlyIncome, todayIso });

    res.render("credit-check", {
      title: `Credit history — ${owner.name}`,
      check,
      purpose: PURPOSES[check.purpose],
      subject: owner.name,
      history,
      today: todayIso
    });
  } catch (error) {
    next(error);
  }
}


// --- The lender's side of a request -----------------------------------------

export function showRequestForm(req, res) {
  res.render("credit-check-request", {
    title: "Ask to see a credit history",
    purposes: PURPOSES,
    sent: null,
    problem: null,
    form: {}
  });
}

// A code that matches nobody and a code that matches somebody are answered the
// same way, and both take the same work: telling them apart would turn this
// form into a way of finding out who banks here.
export async function submitRequest(req, res, next) {
  const form = {
    code: (req.body.code || "").trim(),
    lender: (req.body.lender || "").trim().slice(0, 120),
    purpose: String(req.body.purpose || ""),
    amountSought: req.body.amountSought,
    reference: (req.body.reference || "").trim().slice(0, 80) || null
  };

  const render = (extra) =>
    res.render("credit-check-request", {
      title: "Ask to see a credit history",
      purposes: PURPOSES,
      sent: null,
      problem: null,
      form,
      ...extra
    });

  if (!form.code || !form.lender || !PURPOSES[form.purpose]) {
    return render({ problem: "A code, who is asking, and what for are all needed." });
  }

  try {
    const subject = await findByCreditCode(form.code);
    const amount = Number.parseFloat(form.amountSought);

    // Nothing is created for a code nobody holds, but the page says the same
    // either way. A lender waiting on an answer that never comes has learnt
    // nothing about anybody.
    let token = null;
    if (subject) {
      const made = await createRequest({
        userId: subject.id,
        lender: form.lender,
        purpose: form.purpose,
        amountSought: Number.isFinite(amount) && amount > 0 ? amount : null,
        reference: form.reference
      });
      token = made.token;
    }

    return render({
      sent: {
        url: token ? `${baseUrl()}/credit-check/request/${token}` : null
      }
    });
  } catch (error) {
    return next(error);
  }
}

// The one link the lender keeps. It says waiting until it is answered, and
// becomes the history if the answer was yes.
export async function showRequestStatus(req, res, next) {
  try {
    const request = await getRequestByToken(String(req.params.token || ""));
    if (!request) {
      return res.status(404).render("credit-check-gone", { title: "Credit check unavailable" });
    }

    if (request.status === "pending") {
      return res.render("credit-check-pending", {
        title: "Waiting on a decision",
        request,
        purpose: PURPOSES[request.purpose]
      });
    }

    if (request.status === "denied") {
      return res.status(403).render("credit-check-pending", {
        title: "Request not approved",
        request,
        purpose: PURPOSES[request.purpose]
      });
    }

    // Approved, but the check behind it can still have been revoked or run out.
    const check = request.check_token ? await getCheckByToken(request.check_token) : null;
    const todayIso = today();
    if (!check || !isUsable(check, todayIso)) {
      return res.status(404).render("credit-check-gone", { title: "Credit check unavailable" });
    }

    await recordCheckView(check.id);
    const { facilities, monthlyIncome, owner } = await creditHistoryFor(check.user_id, todayIso);

    return res.render("credit-check", {
      title: `Credit history — ${owner.name}`,
      check,
      purpose: PURPOSES[check.purpose],
      subject: owner.name,
      history: sharedHistory({ facilities, monthlyIncome, todayIso }),
      today: todayIso
    });
  } catch (error) {
    return next(error);
  }
}

// --- The person's side ------------------------------------------------------

export async function approve(req, res, next) {
  try {
    const days = Number.parseInt(req.body.days, 10);
    const made = await approveRequest({
      requestId: Number(req.params.id),
      userId: req.session.user.id,
      days: Number.isInteger(days) && days > 0 ? Math.min(days, MAX_DAYS) : DEFAULT_DAYS
    });

    req.flash(
      made ? "success" : "error",
      made
        ? `${made.lender} can see your standing until ${made.expires_on}. You can stop it before then.`
        : "That request is not here, or you have already answered it."
    );
    return res.redirect("/credit/checks");
  } catch (error) {
    return next(error);
  }
}

export async function deny(req, res, next) {
  try {
    const denied = await denyRequest(Number(req.params.id), req.session.user.id);
    req.flash(
      denied ? "success" : "error",
      denied
        ? "Turned down. They were shown nothing."
        : "That request is not here, or you have already answered it."
    );
    return res.redirect("/credit/checks");
  } catch (error) {
    return next(error);
  }
}
