import {
  createCheck,
  getCheckByToken,
  listCheckViews,
  listChecks,
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
    const checks = await listChecks(userId);
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
