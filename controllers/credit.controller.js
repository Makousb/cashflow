import { listAccounts } from "../db/queries/accounts.js";
import { getDefaultCategoryId } from "../db/queries/categories.js";
import {
  closeFacility,
  creditExposure,
  getFacility,
  getInstallment,
  listApplications,
  listFacilities,
  listInstallments,
  monthlyCommitments,
  monthlyMeans,
  openFacility,
  recordApplication,
  settleInstallment
} from "../db/queries/credit.js";
import { createTransaction, deleteTransaction } from "../db/queries/transactions.js";
import { toBase } from "../services/fx.js";
import { affordability, assess, facilityStanding, PRODUCTS } from "../utils/credit.js";
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

async function creditPageModel(userId) {
  const [facilities, installments, applications, accounts, gathered] = await Promise.all([
    listFacilities(userId),
    listInstallments(userId),
    listApplications(userId),
    listAccounts(userId),
    meansFor(userId)
  ]);

  const byFacility = new Map();
  for (const row of installments) {
    if (!byFacility.has(row.facility_id)) byFacility.set(row.facility_id, []);
    byFacility.get(row.facility_id).push(row);
  }

  const todayIso = today();
  const withStanding = facilities.map((facility) => ({
    ...facility,
    installments: byFacility.get(facility.id) || [],
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

export async function showCreditPage(req, res, next) {
  try {
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

// Closing a card returns the deposit to the wallet it came from.
export async function closeCard(req, res, next) {
  try {
    const userId = req.session.user.id;
    const facility = await getFacility(Number(req.params.id), userId);

    if (!facility || facility.product !== "secured_card") {
      req.flash("error", "That card is not here.");
      return res.redirect("/credit");
    }
    if (facility.status !== "active") {
      req.flash("error", "That card is already closed.");
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
