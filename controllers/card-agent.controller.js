import {
  addRedemption,
  claimAgentPayment,
  claimDailyRun,
  completeAgentPayment,
  getAgentSettings,
  getRun,
  listAgentPayments,
  listRedemptions,
  listRuns,
  recordRunNotification,
  releaseAgentPayment,
  releaseDailyRun,
  saveAgentSettings,
  saveRun
} from "../db/queries/card-agent.js";
import { addCardPayment, listCharges, raiseCardLimit } from "../db/queries/credit.js";
import { listAccounts } from "../db/queries/accounts.js";
import { getDefaultCategoryId } from "../db/queries/categories.js";
import { createTransaction } from "../db/queries/transactions.js";
import { creditPageModel } from "./credit.controller.js";
import { aiEnabled, ask, narrate } from "../services/card-agent.js";
import { mailEnabled, sendMail } from "../services/mailer.js";
import { convert } from "../services/fx.js";
import { config } from "../config/env.js";
import { briefingEmail } from "../utils/agent-email.js";
import { MIN_REDEEM, POINT_VALUE, limitIncrease } from "../utils/cards.js";
import { reviewCards, standingFrom } from "../utils/card-agent.js";
import { CARD_PAYMENT_NOTE } from "../utils/credit.js";
import { formatCurrency } from "../utils/currency.js";
import { DEFAULT_CURRENCY } from "../utils/currencies.js";
import { today } from "../utils/dates.js";

const round = (n) => Math.round(Number(n) * 100) / 100;

// Amounts are stored in the holder's base currency; every move and every note
// quotes them in whatever they are reading in.
function amountFormatter(user) {
  const display = user.currency || user.base_currency || DEFAULT_CURRENCY;
  const base = user.base_currency || display;
  return (amount) => formatCurrency(convert(amount, base, display), display);
}

const daysUntil = (iso, todayIso) =>
  Math.round((Date.parse(`${iso}T00:00:00`) - Date.parse(`${todayIso}T00:00:00`)) / 86400000);

// Everything the agent reads, in one go. The card picture comes from the credit
// page's own model rather than a second assembly of the same rows, so what the
// agent says about a card and what the card's own page says cannot drift.
export async function gather(user, todayIso = today()) {
  const userId = user.id;
  const [model, charges, settings, accounts, redemptions] = await Promise.all([
    creditPageModel(userId, todayIso),
    listCharges(userId),
    getAgentSettings(userId),
    listAccounts(userId),
    listRedemptions(userId)
  ]);

  const standing = standingFrom({
    facilities: model.facilities,
    monthlyIncome: model.means.income,
    todayIso
  });

  const redemptionsByFacility = new Map();
  for (const row of redemptions) {
    if (!redemptionsByFacility.has(row.facility_id)) redemptionsByFacility.set(row.facility_id, []);
    redemptionsByFacility.get(row.facility_id).push(row);
  }

  const review = reviewCards({
    cards: model.facilities,
    means: model.means,
    score: standing.score,
    record: standing.record,
    historyMonths: standing.historyMonths,
    cleanMonths: standing.cleanMonths,
    charges,
    redemptionsByFacility,
    settings: settings || {},
    accounts,
    todayIso
  });

  return { model, review, standing, settings, accounts, charges, redemptionsByFacility, todayIso };
}

// --- Acting ---

// What the agent pays, per statement, under the instructions it was given.
//
// 'minimum' keeps the card straight and nothing more. 'statement' clears what
// the statement asked for, which is what stops interest. 'full' clears the
// balance including this month's spending. Whichever it is, it is capped at what
// is actually owed — paying a card more than it is owed would leave a credit
// balance nothing here knows what to do with.
function autopayAmount(mode, standing, statement) {
  const owing = round(Math.max(statement.minimumDue - statement.paidTowards, 0));
  if (mode === "minimum") return Math.min(owing, standing.balance);
  if (mode === "statement") {
    return round(Math.min(Math.max(statement.balance - statement.paidTowards, 0), standing.balance));
  }
  return standing.balance;
}

// Pay what the standing instructions say to pay, before the dates they say to
// pay it by. This is the part of the agent that spends somebody's money, so
// every step of it is deliberate:
//
//   · nothing happens at all unless autopay was switched on and a wallet named;
//   · the right to pay a cycle is claimed in the database before the money
//     moves, and handed back if it does not, so two runs cannot both pay it;
//   · a wallet that will not cover it is reported rather than overdrawn;
//   · and a statement already past its date is still paid — late is better than
//     never, and the alternative is an agent that gives up exactly when it is
//     needed.
export async function runAutopay({ user, review, todayIso }) {
  const actions = [];
  const fmt = amountFormatter(user);
  if (review.settings.autopay === "off") return actions;

  const wallet = review.wallet;
  if (!wallet) return actions;

  // The wallet's balance is walked down as it goes, so a second card is judged
  // against what is actually left rather than what was there at the start.
  let available = Number(wallet.balance);

  for (const card of review.cards) {
    const standing = card.card;
    const statement = standing.statement;
    if (!statement || statement.met) continue;
    if (daysUntil(statement.dueOn, todayIso) > review.settings.leadDays) continue;

    const amount = round(autopayAmount(review.settings.autopay, standing, statement));
    if (amount <= 0) continue;

    if (available < amount) {
      actions.push({
        kind: "short",
        facilityId: card.id,
        label: card.label,
        amount,
        detail: `Could not pay ${fmt(amount)} on ${card.label}: ${wallet.name} holds ` +
          `${fmt(available)}. Nothing was taken.`
      });
      continue;
    }

    const claim = await claimAgentPayment({
      facilityId: card.id,
      userId: user.id,
      cycle: statement.cycle,
      kind: review.settings.autopay
    });
    // Somebody — another run, or the holder through this same agent — already
    // has this cycle. Not an error; just not ours to pay.
    if (!claim) continue;

    try {
      const categoryId = await getDefaultCategoryId("Loan Payment");
      const transaction = await createTransaction({
        userId: user.id,
        accountId: wallet.id,
        categoryId,
        kind: "expense",
        amount,
        note: `${CARD_PAYMENT_NOTE} — ${card.label} (card agent)`,
        occurredOn: todayIso
      });
      const payment = await addCardPayment({
        facilityId: card.id,
        userId: user.id,
        amount,
        paidOn: todayIso,
        transactionId: transaction.id,
        source: "agent"
      });
      await completeAgentPayment({ id: claim, paymentId: payment.id, amount });

      available = round(available - amount);
      actions.push({
        kind: "paid",
        facilityId: card.id,
        label: card.label,
        amount,
        detail: `Paid ${fmt(amount)} on ${card.label} out of ${wallet.name} — the ` +
          `${statement.cycle} statement was due ${statement.dueOn}.`
      });
    } catch (error) {
      await releaseAgentPayment(claim);
      console.warn(`Card agent: autopay on facility ${card.id} failed (${error.message})`);
      actions.push({
        kind: "failed",
        facilityId: card.id,
        label: card.label,
        amount,
        detail: `Tried to pay ${fmt(amount)} on ${card.label} and could not. Nothing was taken; ` +
          `it will be tried again.`
      });
    }
  }

  return actions;
}

// One implementation behind the button and the daily watch, so a run that
// happened while nobody was looking is exactly the run they would have got by
// clicking. The review is taken again after anything is paid, because paying is
// the whole point and a note written over the old balance would be wrong.
export async function performRun(user, todayIso = today()) {
  const fmt = amountFormatter(user);
  const first = await gather(user, todayIso);
  const actions = await runAutopay({ user, review: first.review, todayIso });

  const settled = actions.some((a) => a.kind === "paid")
    ? await gather(user, todayIso)
    : first;

  const { text: narrative, mode } = await narrate({ review: settled.review, fmt });

  const saved = await saveRun({
    userId: user.id,
    score: settled.standing.score.score,
    utilisation: settled.review.utilisation,
    balance: settled.review.balance,
    points: settled.review.points.balance,
    counts: settled.review.counts,
    narrative,
    mode,
    moves: settled.review.moves,
    actions
  });

  return { ...settled, actions, narrative, mode, saved, fmt };
}

// Post the briefing to whoever the holder nominated. A mail server having a bad
// afternoon costs an email and nothing else — the run itself already happened.
export async function notifyRun({ user, review, actions, narrative, saved, fmt, settings }) {
  const to = (settings?.alert_email || "").trim();
  if (!to || !mailEnabled()) return { sent: false };

  // Nothing happened and nothing needs doing: an email saying so is noise.
  if (actions.length === 0 && review.counts.high === 0 && review.counts.medium === 0) {
    return { sent: false, reason: "nothing worth an email" };
  }

  const base = config.appUrl || `http://localhost:${config.port}`;
  const { subject, text, html } = briefingEmail({
    review,
    actions,
    narrative,
    fmt,
    url: `${base}/credit/agent`,
    when: new Date()
  });

  const result = await sendMail({ to, subject, text, html });
  if (result.sent) await recordRunNotification(saved.id, to);
  return result;
}

// Today's watch, if it has not happened yet. The claim is taken first and handed
// back if the run throws, so a provider outage costs a retry rather than a day.
export async function runDailyWatchIfDue(user, todayIso = today()) {
  const settings = await getAgentSettings(user.id);
  const previous = settings?.last_run_on || null;

  if (!(await claimDailyRun(user.id))) return null;

  try {
    const outcome = await performRun(user, todayIso);
    await notifyRun({ ...outcome, user });
    return outcome;
  } catch (error) {
    await releaseDailyRun(user.id, previous);
    console.warn(`Card agent: daily watch for user ${user.id} failed (${error.message})`);
    return null;
  }
}

// Called from pages the holder is likely to open. Never awaited by the request:
// nothing on a page should wait on a mail server or an AI provider, and a watch
// that fails is logged and tried again rather than surfaced. The promise is
// handed back all the same, so a test can wait for what a request will not.
export function catchUpWatch(user, todayIso = today()) {
  return runDailyWatchIfDue(user, todayIso).catch((error) => {
    console.warn(`Card agent: watch for user ${user.id} failed (${error.message})`);
    return null;
  });
}

// --- Pages ---

const PROMPTS = [
  "What do I owe and when?",
  "Am I close to maxing out?",
  "Which card should I use for groceries?",
  "How do I get a better card?",
  "What is holding my score back?",
  "Where did the money go this month?"
];

export async function showAgent(req, res, next) {
  try {
    const user = req.session.user;
    // Awaited here, unlike everywhere else: this is the page that exists to show
    // what the agent did, so showing it before it has done it would be odd.
    await runDailyWatchIfDue(user);

    const { review, standing, settings, accounts } = await gather(user);
    const [history, paidByAgent] = await Promise.all([
      listRuns(user.id),
      listAgentPayments(user.id, 10)
    ]);

    // listRuns is the index — it carries the headline figures and nothing
    // heavy. The note and what the agent did that day live in the full row, so
    // the one being shown is read back in full.
    const latest = history[0] ? await getRun(history[0].id, user.id) : null;

    return res.render("card-agent", {
      title: "Card agent",
      review,
      standing,
      settings,
      accounts,
      history,
      paidByAgent,
      latest,
      live: aiEnabled(),
      mailReady: mailEnabled(),
      minRedeem: MIN_REDEEM,
      pointValue: POINT_VALUE,
      prompts: PROMPTS
    });
  } catch (error) {
    return next(error);
  }
}

export async function runNow(req, res, next) {
  try {
    const user = req.session.user;
    const outcome = await performRun(user);
    await notifyRun({ ...outcome, user });

    const paid = outcome.actions.filter((a) => a.kind === "paid");
    const total = paid.reduce((sum, a) => sum + a.amount, 0);

    req.flash(
      "success",
      paid.length > 0
        ? `Run complete — ${outcome.fmt(total)} paid across ${paid.length} card` +
          `${paid.length === 1 ? "" : "s"}, and ${outcome.review.counts.total} thing` +
          `${outcome.review.counts.total === 1 ? "" : "s"} left to look at.`
        : outcome.review.clean
          ? "Run complete — everything is where it should be."
          : `Run complete — ${outcome.review.counts.total} thing` +
            `${outcome.review.counts.total === 1 ? "" : "s"} worth doing.`
    );
    return res.redirect("/credit/agent");
  } catch (error) {
    return next(error);
  }
}

const AUTOPAY_MODES = ["off", "minimum", "statement", "full"];

export async function saveSettings(req, res, next) {
  const user = req.session.user;
  const back = "/credit/agent";

  const autopay = AUTOPAY_MODES.includes(req.body.autopay) ? req.body.autopay : "off";
  const leadDays = Math.min(Math.max(Number.parseInt(req.body.leadDays, 10) || 3, 0), 28);
  const target = Math.min(Math.max(Number.parseInt(req.body.utilisationTarget, 10) || 30, 1), 100);
  const email = (req.body.alertEmail || "").trim();

  // Deliberately forgiving: the point is to catch a typo, not to police what a
  // mail server will accept.
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    req.flash("error", "That does not look like an email address.");
    return res.redirect(back);
  }

  try {
    const accounts = await listAccounts(user.id);
    const wanted = req.body.autopayAccountId ? Number(req.body.autopayAccountId) : null;
    // A wallet that is not theirs is not a wallet. Checked rather than trusted:
    // this decides where money leaves from.
    const walletId = accounts.some((a) => a.id === wanted) ? wanted : null;

    if (autopay !== "off" && !walletId) {
      req.flash("error", "Choose the wallet the agent should pay from.");
      return res.redirect(back);
    }

    await saveAgentSettings({
      userId: user.id,
      autopay,
      autopayAccountId: walletId,
      leadDays,
      utilisationTarget: target,
      chargeGuard: req.body.chargeGuard === "on",
      alertEmail: email || null
    });

    req.flash(
      "success",
      autopay === "off"
        ? "Autopay is off — the agent will watch and advise, and pay nothing."
        : `The agent will pay ${autopay === "minimum" ? "the minimum" : "the balance"} ` +
          `${leadDays} day${leadDays === 1 ? "" : "s"} before each date, and hold you to ` +
          `${target}% of your limits.`
    );
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

// Points off a balance. No money moves, so the payment carries no ledger entry —
// which is exactly what source = 'points' is there to say.
export async function redeemPoints(req, res, next) {
  const user = req.session.user;
  const back = "/credit/agent";

  try {
    const { review } = await gather(user);
    const card = review.cards.find((c) => c.id === Number(req.params.id));

    if (!card) {
      req.flash("error", "That card is not here.");
      return res.redirect(back);
    }
    if (card.points.balance < MIN_REDEEM) {
      req.flash(
        "error",
        `${MIN_REDEEM} points are needed to redeem. ${card.label} has ${card.points.balance}.`
      );
      return res.redirect(back);
    }
    if (card.card.balance <= 0) {
      req.flash("error", "There is nothing owing on that card for points to come off.");
      return res.redirect(back);
    }

    // Points are only worth anything against a balance, so no more of them are
    // spent than the balance can absorb. The rest stay banked.
    const affordable = Math.min(card.points.balance, Math.floor(card.card.balance / POINT_VALUE));
    const points = Math.max(affordable, 0);
    const amount = round(points * POINT_VALUE);

    if (points <= 0 || amount <= 0) {
      req.flash("error", "There is nothing owing on that card for points to come off.");
      return res.redirect(back);
    }

    const payment = await addCardPayment({
      facilityId: card.id,
      userId: user.id,
      amount,
      paidOn: today(),
      transactionId: null,
      source: "points"
    });
    await addRedemption({
      facilityId: card.id,
      userId: user.id,
      points,
      amount,
      paymentId: payment.id,
      redeemedOn: today()
    });

    const fmt = amountFormatter(user);
    req.flash(
      "success",
      `${points} points redeemed — ${fmt(amount)} off ${card.label}, and no money left your wallet.`
    );
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

// Take the higher limit the record has earned. Re-checked here rather than
// trusted from the form: this raises what somebody may spend.
export async function raiseLimit(req, res, next) {
  const user = req.session.user;
  const back = "/credit/agent";

  try {
    const { review, standing, model } = await gather(user);
    const card = review.cards.find((c) => c.id === Number(req.params.id));

    if (!card) {
      req.flash("error", "That card is not here.");
      return res.redirect(back);
    }

    const offer = limitIncrease({
      facility: card,
      monthlyIncome: model.means.income,
      cleanMonths: standing.cleanMonths
    });
    if (!offer.eligible) {
      req.flash("error", offer.reason);
      return res.redirect(back);
    }

    const raised = await raiseCardLimit({
      facilityId: card.id,
      userId: user.id,
      limit: offer.entitled
    });
    if (!raised) {
      req.flash("error", "That limit could not be raised.");
      return res.redirect(back);
    }

    const fmt = amountFormatter(user);
    const after = offer.entitled > 0
      ? Math.min(Math.round((card.card.balance / offer.entitled) * 100), 100)
      : 0;
    req.flash(
      "success",
      `${card.label} now has a limit of ${fmt(offer.entitled)} — up ${fmt(offer.raise)}.` +
      // Only worth saying when there is a balance for it to be a share of.
      // "0% instead of 0%" is arithmetic nobody asked for.
      (card.card.balance > 0
        ? ` The same balance is now ${after}% of it instead of ${card.card.utilisation}%.`
        : "")
    );
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

export async function askAgent(req, res, next) {
  try {
    const question = (req.body.question || "").trim();
    if (!question) {
      return res.status(400).json({ error: "Ask a question." });
    }

    const { review } = await gather(req.session.user);
    const answer = await ask(question, review, (n) => res.locals.money(n));

    return res.json({ answer: answer.text, mode: answer.mode });
  } catch (error) {
    return next(error);
  }
}
