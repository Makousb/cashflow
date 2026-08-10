import { listAccounts } from "../db/queries/accounts.js";
import { getDefaultCategoryId } from "../db/queries/categories.js";
import {
  addCardPayment,
  addCharge,
  biggestPurchasesInYear,
  claimCardNotice,
  closeFacility,
  creditOpenedInYear,
  creditExposure,
  getFacility,
  getInstallment,
  listApplications,
  listCardPayments,
  listCharges,
  listFacilities,
  listInstallments,
  monthlyCommitments,
  monthlyMeans,
  openFacility,
  recordApplication,
  releaseCardNotice,
  settleInstallment,
  spendingByCategoryInYear,
  yearsWithActivity
} from "../db/queries/credit.js";
import { createTransaction, deleteTransaction } from "../db/queries/transactions.js";
import { config } from "../config/env.js";
import { formatCurrency } from "../utils/currency.js";
import { minimumDueSoonEmail, missedMinimumEmail } from "../utils/card-notice-email.js";
import { creditReport } from "../utils/credit-report.js";
import { mailEnabled, sendMail } from "../services/mailer.js";
import { toBase } from "../services/fx.js";
import {
  affordability,
  assess,
  assessCharge,
  cardStanding,
  facilityStanding,
  noticeDue,
  PRODUCTS
} from "../utils/credit.js";
import { today } from "../utils/dates.js";

// Everything a decision is made from, gathered once.
async function meansFor(userId) {
  const [means, commitments, exposure] = await Promise.all([
    monthlyMeans(userId, 3),
    monthlyCommitments(userId),
    creditExposure(userId)
  ]);

  return {
    means: affordability({
      monthlyIncome: Number(means.monthly_income),
      monthlyExpenses: Number(means.monthly_expenses),
      monthlyCommitments: commitments
    }),
    exposure
  };
}

const groupBy = (rows, key) => {
  const out = new Map();
  for (const row of rows) {
    if (!out.has(row[key])) out.set(row[key], []);
    out.get(row[key]).push(row);
  }
  return out;
};

// todayIso is a parameter rather than a call to today() so a test can put the
// clock where it needs it. Requests never pass one.
async function creditPageModel(userId, todayIso = today()) {
  const [facilities, installments, charges, cardPayments, applications, accounts, gathered] =
    await Promise.all([
      listFacilities(userId),
      listInstallments(userId),
      listCharges(userId),
      listCardPayments(userId),
      listApplications(userId),
      listAccounts(userId),
      meansFor(userId)
    ]);

  const byFacility = groupBy(installments, "facility_id");
  const chargesBy = groupBy(charges, "facility_id");
  const paymentsBy = groupBy(cardPayments, "facility_id");

  const withStanding = facilities.map((facility) => ({
    ...facility,
    installments: byFacility.get(facility.id) || [],
    charges: chargesBy.get(facility.id) || [],
    cardPayments: paymentsBy.get(facility.id) || [],
    card: facility.product === "secured_card"
      ? cardStanding(
          facility,
          chargesBy.get(facility.id) || [],
          paymentsBy.get(facility.id) || [],
          todayIso
        )
      : null,
    standing: facilityStanding(facility, byFacility.get(facility.id) || [], todayIso)
  }));

  const active = withStanding.filter((f) => f.status === "active");
  return {
    facilities: withStanding,
    active,
    applications,
    accounts,
    means: gathered.means,
    exposure: gathered.exposure,
    owed: active.reduce((sum, f) => sum + f.standing.outstanding, 0),
    todayIso
  };
}

// Tell the holder about a statement that wants paying — before its date, or
// after it if that has already gone by. Which of the two is noticeDue's call.
//
// The claim is taken before the mail goes and handed back if it does not, so a
// mail server having a bad afternoon costs a reminder rather than swallowing it
// — and the unique key means two requests arriving together cannot both send.
// Once per statement per kind: two emails about one statement at the very most,
// and never the same one twice.
async function noticeFor(user, facility, standing) {
  const owed = noticeDue(standing);
  if (!owed) return { sent: false };

  const { kind, statement } = owed;
  const to = (user.email || "").trim();
  if (!to || !mailEnabled()) return { sent: false, reason: "nowhere to send it" };

  const claimed = await claimCardNotice({
    facilityId: facility.id,
    userId: user.id,
    cycle: statement.cycle,
    kind,
    sentTo: to
  });
  if (!claimed) return { sent: false, reason: "already told" };

  const base = config.appUrl || `http://localhost:${config.port}`;
  const currency = user.currency || user.base_currency;
  const build = kind === "reminder" ? minimumDueSoonEmail : missedMinimumEmail;
  const { subject, text, html } = build({
    facility,
    statement,
    standing,
    fmt: (amount) => formatCurrency(amount, currency),
    url: `${base}/credit`
  });

  const result = await sendMail({ to, subject, text, html });
  if (!result.sent) {
    await releaseCardNotice({ facilityId: facility.id, cycle: statement.cycle, kind });
  }
  return { ...result, kind };
}

// Called from pages the holder is likely to open. Never awaited by the request:
// nothing on a page should wait on a mail server, and a reminder that fails is
// logged and tried again next time rather than surfaced. The promise is handed
// back all the same, so a test can wait for what a request will not.
export function catchUpCardNotices(user, todayIso = today()) {
  return creditPageModel(user.id, todayIso)
    .then(async (model) => {
      for (const facility of model.active) {
        // Whether anything is owed at all is noticeDue's decision, not a
        // condition to duplicate here — gating on "missed" was how the first
        // version of this would never have sent a reminder.
        if (facility.card) {
          await noticeFor(user, facility, facility.card);
        }
      }
    })
    .catch((error) => {
      console.warn(`Credit: card notices for user ${user.id} failed (${error.message})`);
    });
}

export async function showCreditPage(req, res, next) {
  try {
    catchUpCardNotices(req.session.user);
    const model = await creditPageModel(req.session.user.id);
    res.render("credit", {
      title: "Credit",
      products: PRODUCTS,
      ...model,
      today: model.todayIso
    });
  } catch (error) {
    next(error);
  }
}

// A year of it, in one page. The year comes off the query string so an old one
// can be looked at; anything that is not a year falls back to this one.
export async function showCreditReport(req, res, next) {
  try {
    const user = req.session.user;
    const todayIso = today();
    const thisYear = Number(todayIso.slice(0, 4));

    const asked = Number.parseInt(req.query.year, 10);
    const year = Number.isInteger(asked) && asked >= 1970 && asked <= thisYear
      ? asked
      : thisYear;

    const [model, opened, categories, purchases, years] = await Promise.all([
      creditPageModel(user.id, todayIso),
      creditOpenedInYear(user.id, year),
      spendingByCategoryInYear(user.id, year),
      biggestPurchasesInYear(user.id, year, 10),
      yearsWithActivity(user.id)
    ]);

    const report = creditReport({
      year,
      facilities: model.facilities,
      opened,
      categories,
      purchases,
      monthlyIncome: model.means.income,
      todayIso
    });

    res.render("credit-report", {
      title: `Credit report ${year}`,
      report,
      years: years.length ? years : [thisYear],
      products: PRODUCTS
    });
  } catch (error) {
    next(error);
  }
}

// One handler for all three: they differ in what they ask for and what happens
// on approval, not in the shape of the thing.
export async function apply(req, res, next) {
  const product = String(req.body.product || "");
  if (!PRODUCTS[product]) {
    req.flash("error", "Choose one of the products.");
    return res.redirect("/credit");
  }

  const user = req.session.user;
  const userId = user.id;
  const amountInput = Number.parseFloat(req.body.amount);

  if (!Number.isFinite(amountInput) || amountInput <= 0) {
    req.flash("error", "Enter an amount greater than zero.");
    return res.redirect("/credit");
  }

  try {
    // Typed in the display currency; every figure below is base.
    const amount = toBase(user, amountInput);
    const term = Number.parseInt(req.body.term, 10) || 0;
    const purpose = (req.body.purpose || "").trim().slice(0, 200) || null;
    const accountId = req.body.accountId ? Number(req.body.accountId) : null;
    const decidedOn = today();

    const { means, exposure } = await meansFor(userId);
    const accounts = await listAccounts(userId);
    const wallet = accounts.find((a) => a.id === accountId) || null;

    const decision = assess(product, {
      amount,
      days: term,
      installments: term,
      deposit: amount,
      means,
      from: decidedOn,
      walletBalance: wallet ? Number(wallet.balance) : 0,
      hasActiveDayLoan: exposure.active_day_loans > 0,
      hasActiveCard: exposure.active_cards > 0,
      outstandingPlans: Number(exposure.outstanding_plans)
    });

    const application = await recordApplication({
      userId,
      product,
      amount,
      term,
      purpose,
      status: decision.approved ? "approved" : "declined",
      reason: decision.reason,
      fee: decision.terms?.fee ?? 0,
      apr: decision.terms?.apr ?? 0,
      creditLimit: decision.terms?.creditLimit ?? null,
      deposit: decision.terms?.deposit ?? null,
      decidedOn
    });

    if (!decision.approved) {
      // Declines are kept and shown rather than thrown away — the reason is the
      // only part of an application that was ever worth anything.
      req.flash("error", `Not approved: ${decision.reason}`);
      return res.redirect("/credit");
    }

    await openApproved({
      req, userId, product, application, decision, purpose, accountId, decidedOn
    });

    req.flash("success", `Approved. ${decision.reason}`);
    return res.redirect("/credit");
  } catch (error) {
    return next(error);
  }
}

// Turning an approval into money, which differs per product: a day loan pays
// out, a plan moves nothing yet, and a card takes a deposit in.
async function openApproved({ req, userId, product, application, decision, purpose, accountId, decidedOn }) {
  const terms = decision.terms;
  const label = purpose || PRODUCTS[product].label;

  let transactionId = null;

  if (product === "day_loan") {
    // The money arrives, so the ledger says so.
    const categoryId = await getDefaultCategoryId("Other Income");
    const transaction = await createTransaction({
      userId,
      accountId: accountId || null,
      categoryId,
      kind: "income",
      amount: terms.principal,
      note: `Day loan drawdown — ${label}`,
      occurredOn: decidedOn
    });
    transactionId = transaction.id;
  }

  if (product === "secured_card") {
    // The deposit leaves the wallet. It is not spending, but it does leave, and
    // the ledger is how this app knows what a wallet holds.
    const categoryId = await getDefaultCategoryId("Other");
    const transaction = await createTransaction({
      userId,
      accountId: accountId || null,
      categoryId,
      kind: "expense",
      amount: terms.deposit,
      note: `Secured card deposit — ${label}`,
      occurredOn: decidedOn
    });
    transactionId = transaction.id;
  }

  await openFacility({
    userId,
    applicationId: application.id,
    product,
    label,
    principal: terms.principal,
    fee: terms.fee,
    apr: terms.apr,
    creditLimit: terms.creditLimit ?? null,
    deposit: terms.deposit ?? null,
    openedOn: decidedOn,
    dueOn: terms.dueOn,
    transactionId,
    schedule: terms.schedule
  });
}

// Paying an instalment posts the expense and links the two, the way a loan
// payment already does, so repayments show up in spending like any other money
// going out.
export async function payInstallment(req, res, next) {
  try {
    const user = req.session.user;
    const userId = user.id;

    const installment = await getInstallment(Number(req.params.id), userId);
    if (!installment) {
      req.flash("error", "That instalment is not here.");
      return res.redirect("/credit");
    }
    if (installment.paid_on) {
      req.flash("error", "That instalment is already paid.");
      return res.redirect("/credit");
    }

    const facility = await getFacility(installment.facility_id, userId);
    const paidOn = req.body.paidOn || today();
    const categoryId = await getDefaultCategoryId("Loan Payment");

    const transaction = await createTransaction({
      userId,
      accountId: req.body.accountId || null,
      categoryId,
      kind: "expense",
      amount: Number(installment.amount),
      note: `Credit repayment: ${facility ? facility.label : "credit"}`,
      occurredOn: paidOn
    });

    const result = await settleInstallment({
      installmentId: installment.id,
      userId,
      paidOn,
      transactionId: transaction.id
    });

    if (!result.updated) {
      // Someone else got there first between the read and the write. Take the
      // expense back out rather than leaving a payment for nothing.
      await deleteTransaction(transaction.id, userId);
      req.flash("error", "That instalment was already paid.");
      return res.redirect("/credit");
    }

    req.flash(
      "success",
      result.settled ? "Paid, and that clears it." : "Instalment paid and logged as an expense."
    );
    return res.redirect("/credit");
  } catch (error) {
    return next(error);
  }
}

// A card is only good for what is left on it, so both of these read the
// standing first and refuse against it.
async function cardWithStanding(id, userId) {
  const facility = await getFacility(id, userId);
  if (!facility || facility.product !== "secured_card") return null;

  const [charges, payments] = await Promise.all([listCharges(userId), listCardPayments(userId)]);
  return {
    facility,
    standing: cardStanding(
      facility,
      charges.filter((c) => c.facility_id === facility.id),
      payments.filter((p) => p.facility_id === facility.id),
      today()
    )
  };
}

// Spending on the card. Nothing is posted to the ledger here — the books are
// cash basis and the spending lands when the card is paid, so recording it in
// both places would count the same purchase twice.
export async function chargeCard(req, res, next) {
  try {
    const user = req.session.user;
    const held = await cardWithStanding(Number(req.params.id), user.id);

    if (!held) {
      req.flash("error", "That card is not here.");
      return res.redirect("/credit");
    }
    if (held.facility.status !== "active") {
      req.flash("error", "That card is closed.");
      return res.redirect("/credit");
    }

    const merchant = (req.body.merchant || "").trim().slice(0, 120);
    if (!merchant) {
      req.flash("error", "Say what the purchase was.");
      return res.redirect("/credit");
    }

    const amount = toBase(user, Number.parseFloat(req.body.amount));
    const decision = assessCharge({ amount, standing: held.standing });
    if (!decision.approved) {
      req.flash("error", `Declined: ${decision.reason}`);
      return res.redirect("/credit");
    }

    await addCharge({
      facilityId: held.facility.id,
      userId: user.id,
      merchant,
      amount: decision.terms.amount,
      chargedOn: req.body.chargedOn || today()
    });

    req.flash("success", `Charged to the card. ${decision.reason}`);
    return res.redirect("/credit");
  } catch (error) {
    return next(error);
  }
}

// Paying the card down. This is where the spending reaches the ledger.
export async function payCard(req, res, next) {
  try {
    const user = req.session.user;
    const held = await cardWithStanding(Number(req.params.id), user.id);

    if (!held) {
      req.flash("error", "That card is not here.");
      return res.redirect("/credit");
    }

    const asked = toBase(user, Number.parseFloat(req.body.amount));
    if (!Number.isFinite(asked) || asked <= 0) {
      req.flash("error", "Enter a payment greater than zero.");
      return res.redirect("/credit");
    }
    if (held.standing.balance <= 0) {
      req.flash("error", "There is nothing owing on that card.");
      return res.redirect("/credit");
    }

    // Paying in more than is owed would leave a credit balance nothing here
    // knows what to do with, so it is capped at what is actually owed.
    const amount = Math.min(asked, held.standing.balance);
    const categoryId = await getDefaultCategoryId("Loan Payment");
    const transaction = await createTransaction({
      userId: user.id,
      accountId: req.body.accountId || null,
      categoryId,
      kind: "expense",
      amount,
      note: `Card payment — ${held.facility.label}`,
      occurredOn: req.body.paidOn || today()
    });

    await addCardPayment({
      facilityId: held.facility.id,
      userId: user.id,
      amount,
      paidOn: req.body.paidOn || today(),
      transactionId: transaction.id
    });

    req.flash(
      "success",
      amount < asked
        ? "Paid off in full — only what was owing was taken."
        : "Card payment recorded and logged as an expense."
    );
    return res.redirect("/credit");
  } catch (error) {
    return next(error);
  }
}

// Closing a card returns the deposit to the wallet it came from.
export async function closeCard(req, res, next) {
  try {
    const userId = req.session.user.id;
    const held = await cardWithStanding(Number(req.params.id), userId);

    if (!held) {
      req.flash("error", "That card is not here.");
      return res.redirect("/credit");
    }
    const facility = held.facility;
    if (facility.status !== "active") {
      req.flash("error", "That card is already closed.");
      return res.redirect("/credit");
    }
    // The deposit is not a way to pay the card off. Clearing the balance first
    // is the point of it being a deposit rather than a payment.
    if (held.standing.balance > 0) {
      req.flash(
        "error",
        `There is still ${held.standing.balance.toFixed(2)} owing on that card. ` +
        "Pay it off and the deposit comes back."
      );
      return res.redirect("/credit");
    }

    const closed = await closeFacility(facility.id, userId);
    if (!closed) {
      req.flash("error", "That card is already closed.");
      return res.redirect("/credit");
    }

    const categoryId = await getDefaultCategoryId("Other Income");
    await createTransaction({
      userId,
      accountId: req.body.accountId || null,
      categoryId,
      kind: "income",
      amount: Number(facility.deposit || 0),
      note: `Secured card deposit returned — ${facility.label}`,
      occurredOn: today()
    });

    req.flash("success", "Card closed and the deposit returned to your wallet.");
    return res.redirect("/credit");
  } catch (error) {
    return next(error);
  }
}
