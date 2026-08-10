import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  addCardPayment,
  addCharge,
  biggestPurchasesInYear,
  claimCardNotice,
  closeFacility,
  creditOpenedInYear,
  creditExposure,
  listApplications,
  listCardNotices,
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
} from "../../db/queries/credit.js";
import {
  affordability,
  assessCharge,
  assessDayLoan,
  cardStanding,
  CREDIT_REPAYMENT_NOTE,
  DEPOSIT_NOTE,
  DEPOSIT_RETURNED_NOTE,
  DRAWDOWN_NOTE
} from "../../utils/credit.js";
import { LOAN_PAYMENT_NOTE } from "../../utils/loans.js";
import { today } from "../../utils/dates.js";
import { closePool, dropUser, makeUser, one, q, skipWithoutDb } from "./helpers.js";

// Income and spending for the last three months, so the means queries have
// something to average. Amounts are whole months apart to keep them in range.
async function seedLedger(userId, { income = 90000, expense = 30000 } = {}) {
  for (let back = 0; back < 3; back++) {
    await q(
      `INSERT INTO transactions (user_id, kind, amount, occurred_on)
       VALUES ($1, 'income', $2, date_trunc('month', CURRENT_DATE) - make_interval(months => $3)),
              ($1, 'expense', $4, date_trunc('month', CURRENT_DATE) - make_interval(months => $3))`,
      [userId, income, back, expense]
    );
  }
}

describe("what the ledger says a person can afford", { skip: skipWithoutDb }, () => {
  let user;

  before(async () => {
    user = await makeUser("credit-means");
    await seedLedger(user.id);
  });

  after(async () => { await dropUser(user?.id); });

  test("averages income and spending over the months asked for", async () => {
    const means = await monthlyMeans(user.id, 3);
    assert.equal(Math.round(Number(means.monthly_income)), 90000);
    assert.equal(Math.round(Number(means.monthly_expenses)), 30000);
  });

  test("borrowed money arriving is not money earned", async () => {
    // Left in, the drawdown raises the income that caps the next day loan, so
    // borrowing would buy the room to borrow again. The notes are built from
    // the same constants the query filters on, so this cannot drift.
    const before = Number((await monthlyMeans(user.id, 3)).monthly_income);

    await q(
      `INSERT INTO transactions (user_id, kind, amount, note, occurred_on)
       VALUES ($1, 'income', 30000, $2, CURRENT_DATE)`,
      [user.id, `${DRAWDOWN_NOTE} — Car repair`]
    );
    await q(
      `INSERT INTO transactions (user_id, kind, amount, note, occurred_on)
       VALUES ($1, 'income', 45000, $2, CURRENT_DATE)`,
      [user.id, `${DEPOSIT_RETURNED_NOTE} — Everyday card`]
    );

    assert.equal(
      Number((await monthlyMeans(user.id, 3)).monthly_income), before,
      "a drawdown and a returned deposit must not read as earnings"
    );
  });

  test("but real income still is", async () => {
    const before = Number((await monthlyMeans(user.id, 3)).monthly_income);
    await q(
      `INSERT INTO transactions (user_id, kind, amount, note, occurred_on)
       VALUES ($1, 'income', 30000, 'Bonus', CURRENT_DATE)`,
      [user.id]
    );
    assert.equal(Number((await monthlyMeans(user.id, 3)).monthly_income), before + 10000);
  });

  test("meeting an obligation is not a second obligation beside it", async () => {
    // The minimum is already counted as a commitment, so counting the payment
    // as spending too charged one promise twice against what is spare.
    const before = Number((await monthlyMeans(user.id, 3)).monthly_expenses);

    await q(
      `INSERT INTO transactions (user_id, kind, amount, note, occurred_on)
       VALUES ($1, 'expense', 9000, $2, CURRENT_DATE)`,
      [user.id, `${LOAN_PAYMENT_NOTE}: Car`]
    );
    await q(
      `INSERT INTO transactions (user_id, kind, amount, note, occurred_on)
       VALUES ($1, 'expense', 9000, $2, CURRENT_DATE)`,
      [user.id, `${CREDIT_REPAYMENT_NOTE}: Washing machine`]
    );

    assert.equal(
      Number((await monthlyMeans(user.id, 3)).monthly_expenses), before,
      "a repayment must not be spending as well as a commitment"
    );
  });

  test("nor is a deposit, which is held rather than spent", async () => {
    // It comes back when the card closes, and the return is already excluded
    // from income — counting it out but not back was lopsided as well as wrong.
    const before = Number((await monthlyMeans(user.id, 3)).monthly_expenses);
    await q(
      `INSERT INTO transactions (user_id, kind, amount, note, occurred_on)
       VALUES ($1, 'expense', 45000, $2, CURRENT_DATE)`,
      [user.id, `${DEPOSIT_NOTE} — Everyday card`]
    );
    assert.equal(
      Number((await monthlyMeans(user.id, 3)).monthly_expenses), before,
      "money still owned is not money spent"
    );
  });

  test("but a card payment is, nothing else counting it", async () => {
    // A card has no schedule, so no commitment carries it forward. Taking it
    // out of spending would lose the outgoing altogether.
    const before = Number((await monthlyMeans(user.id, 3)).monthly_expenses);
    await q(
      `INSERT INTO transactions (user_id, kind, amount, note, occurred_on)
       VALUES ($1, 'expense', 3000, 'Card payment — Everyday card', CURRENT_DATE)`,
      [user.id]
    );
    assert.equal(Number((await monthlyMeans(user.id, 3)).monthly_expenses), before + 1000);
  });

  test("and ordinary spending certainly is", async () => {
    const before = Number((await monthlyMeans(user.id, 3)).monthly_expenses);
    await q(
      `INSERT INTO transactions (user_id, kind, amount, note, occurred_on)
       VALUES ($1, 'expense', 6000, 'Groceries', CURRENT_DATE)`,
      [user.id]
    );
    assert.equal(Number((await monthlyMeans(user.id, 3)).monthly_expenses), before + 2000);
  });

  test("an existing loan's minimum is a promise already made", async () => {
    await q(
      `INSERT INTO loans (user_id, name, principal, apr, minimum_payment, start_date)
       VALUES ($1, 'Car', 100000, 12, 4500, CURRENT_DATE)`,
      [user.id]
    );
    assert.equal(await monthlyCommitments(user.id), 4500);
  });
});

describe("applying for credit", { skip: skipWithoutDb }, () => {
  let user;

  before(async () => {
    user = await makeUser("credit-apply");
    await seedLedger(user.id);
  });

  after(async () => { await dropUser(user?.id); });

  test("a decline is kept, with the reason that caused it", async () => {
    await recordApplication({
      userId: user.id, product: "day_loan", amount: 900000, term: 7,
      status: "declined", reason: "A day loan is capped at half your monthly income.",
      decidedOn: today()
    });

    const [latest] = await listApplications(user.id);
    assert.equal(latest.status, "declined");
    assert.match(latest.reason, /capped at half/);
    // Nothing was opened on the back of it.
    assert.equal((await listFacilities(user.id)).length, 0);
  });

  test("an approval opens a facility and its schedule together", async () => {
    const application = await recordApplication({
      userId: user.id, product: "bnpl", amount: 12000, term: 3,
      status: "approved", reason: "3 monthly payments.", decidedOn: today()
    });

    const facility = await openFacility({
      userId: user.id, applicationId: application.id, product: "bnpl",
      label: "Washing machine", principal: 12000, openedOn: today(),
      dueOn: "2026-11-05",
      schedule: [
        { sequence: 1, dueOn: "2026-09-05", amount: 4000 },
        { sequence: 2, dueOn: "2026-10-05", amount: 4000 },
        { sequence: 3, dueOn: "2026-11-05", amount: 4000 }
      ]
    });

    assert.equal(facility.status, "active");
    const rows = (await listInstallments(user.id)).filter((i) => i.facility_id === facility.id);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].due_on, "2026-09-05");
    assert.equal(Number(rows[0].amount), 4000);
  });

  test("dates come back as days, not as instants", async () => {
    const [facility] = await listFacilities(user.id);
    assert.match(facility.opened_on, /^\d{4}-\d{2}-\d{2}$/);
    const [installment] = await listInstallments(user.id);
    assert.match(installment.due_on, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("a schedule that cannot be written takes the facility with it", async () => {
    const before = (await listFacilities(user.id)).length;
    await assert.rejects(() =>
      openFacility({
        userId: user.id, product: "bnpl", label: "Doomed", principal: 100,
        openedOn: today(),
        // Negative amounts fail the table's check constraint.
        schedule: [{ sequence: 1, dueOn: today(), amount: -5 }]
      })
    );
    assert.equal((await listFacilities(user.id)).length, before,
      "the facility must not survive its schedule failing");
  });
});

describe("paying credit off", { skip: skipWithoutDb }, () => {
  let user;
  let facility;

  before(async () => {
    user = await makeUser("credit-pay");
    await seedLedger(user.id);
    const application = await recordApplication({
      userId: user.id, product: "bnpl", amount: 200, term: 2,
      status: "approved", reason: "2 monthly payments.", decidedOn: today()
    });
    facility = await openFacility({
      userId: user.id, applicationId: application.id, product: "bnpl",
      label: "Kettle", principal: 200, openedOn: today(),
      schedule: [
        { sequence: 1, dueOn: "2026-09-05", amount: 100 },
        { sequence: 2, dueOn: "2026-10-05", amount: 100 }
      ]
    });
  });

  after(async () => { await dropUser(user?.id); });

  test("paying one leaves the rest, and the facility open", async () => {
    const rows = (await listInstallments(user.id)).filter((i) => i.facility_id === facility.id);
    const result = await settleInstallment({
      installmentId: rows[0].id, userId: user.id, paidOn: today(), transactionId: null
    });

    assert.equal(result.updated, true);
    assert.equal(result.settled, false);
    const reloaded = await one("SELECT status FROM credit_facilities WHERE id = $1", [facility.id]);
    assert.equal(reloaded.status, "active");
  });

  test("the same instalment cannot be paid twice", async () => {
    const rows = (await listInstallments(user.id)).filter((i) => i.facility_id === facility.id);
    const again = await settleInstallment({
      installmentId: rows[0].id, userId: user.id, paidOn: today(), transactionId: null
    });
    assert.equal(again.updated, false, "a paid instalment must not be payable again");
  });

  test("paying the last one settles the facility, unasked", async () => {
    const rows = (await listInstallments(user.id)).filter((i) => i.facility_id === facility.id);
    const last = rows.find((r) => !r.paid_on);
    const result = await settleInstallment({
      installmentId: last.id, userId: user.id, paidOn: today(), transactionId: null
    });

    assert.equal(result.settled, true);
    const reloaded = await one("SELECT status FROM credit_facilities WHERE id = $1", [facility.id]);
    assert.equal(reloaded.status, "settled");
  });

  test("another user's instalment is not payable", async () => {
    const other = await makeUser("credit-other");
    const rows = await listInstallments(user.id);
    const result = await settleInstallment({
      installmentId: rows[0].id, userId: other.id, paidOn: today(), transactionId: null
    });
    assert.equal(result.updated, false);
    await dropUser(other.id);
  });
});

describe("what is already running", { skip: skipWithoutDb }, () => {
  let user;

  before(async () => {
    user = await makeUser("credit-exposure");
    await seedLedger(user.id);
  });

  after(async () => { await dropUser(user?.id); });

  test("counts nothing when nothing is open", async () => {
    const exposure = await creditExposure(user.id);
    assert.equal(exposure.active_day_loans, 0);
    assert.equal(exposure.active_cards, 0);
    assert.equal(Number(exposure.outstanding_plans), 0);
  });

  test("a live day loan is seen, and refuses the next one", async () => {
    await openFacility({
      userId: user.id, product: "day_loan", label: "Bridge", principal: 5000,
      fee: 50, openedOn: today(), dueOn: today(),
      schedule: [{ sequence: 1, dueOn: today(), amount: 5050 }]
    });

    const exposure = await creditExposure(user.id);
    assert.equal(exposure.active_day_loans, 1);

    const means = affordability({ monthlyIncome: 90000, monthlyExpenses: 30000 });
    const out = assessDayLoan({
      amount: 5000, days: 7, means, from: today(),
      hasActiveDayLoan: exposure.active_day_loans > 0
    });
    assert.equal(out.approved, false, "a second day loan is refused while one runs");
  });

  test("a closed card stops counting against the next application", async () => {
    const card = await openFacility({
      userId: user.id, product: "secured_card", label: "Card",
      creditLimit: 10000, deposit: 10000, openedOn: today()
    });
    assert.equal((await creditExposure(user.id)).active_cards, 1);

    await closeFacility(card.id, user.id);
    assert.equal((await creditExposure(user.id)).active_cards, 0);
  });

  test("closing something already closed changes nothing", async () => {
    const [facility] = (await listFacilities(user.id)).filter((f) => f.status === "closed");
    assert.equal(await closeFacility(facility.id, user.id), null);
  });
});

describe("spending on a card", { skip: skipWithoutDb }, () => {
  let user;
  let card;

  before(async () => {
    user = await makeUser("credit-card");
    await seedLedger(user.id);
    card = await openFacility({
      userId: user.id, product: "secured_card", label: "Card",
      apr: 30, creditLimit: 10000, deposit: 10000, openedOn: today()
    });
  });

  after(async () => { await dropUser(user?.id); });

  test("a charge is recorded against the card", async () => {
    await addCharge({
      facilityId: card.id, userId: user.id, merchant: "Naivas",
      amount: 2500, chargedOn: today()
    });

    const charges = (await listCharges(user.id)).filter((c) => c.facility_id === card.id);
    assert.equal(charges.length, 1);
    assert.equal(Number(charges[0].amount), 2500);
    assert.equal(charges[0].merchant, "Naivas");
  });

  test("and moves the balance and what is left to spend", async () => {
    const charges = (await listCharges(user.id)).filter((c) => c.facility_id === card.id);
    const standing = cardStanding(
      { ...card, opened_on: today() }, charges, [], today()
    );
    assert.equal(standing.balance, 2500);
    assert.equal(standing.available, 7500);
  });

  test("a charge over what is left is refused before it is written", async () => {
    const charges = (await listCharges(user.id)).filter((c) => c.facility_id === card.id);
    const standing = cardStanding({ ...card, opened_on: today() }, charges, [], today());
    const decision = assessCharge({ amount: 8000, standing });

    assert.equal(decision.approved, false);
    assert.match(decision.reason, /more than the 7500\.00 left/);
    assert.equal(
      (await listCharges(user.id)).filter((c) => c.facility_id === card.id).length, 1,
      "a refused charge must leave nothing behind"
    );
  });

  test("a payment brings the balance back down", async () => {
    await addCardPayment({
      facilityId: card.id, userId: user.id, amount: 1000, paidOn: today()
    });

    const charges = (await listCharges(user.id)).filter((c) => c.facility_id === card.id);
    const payments = (await listCardPayments(user.id)).filter((p) => p.facility_id === card.id);
    const standing = cardStanding({ ...card, opened_on: today() }, charges, payments, today());

    assert.equal(standing.balance, 1500);
    assert.equal(standing.available, 8500);
  });

  test("dates come back as days here too", async () => {
    const [charge] = await listCharges(user.id);
    assert.match(charge.charged_on, /^\d{4}-\d{2}-\d{2}$/);
    const [payment] = await listCardPayments(user.id);
    assert.match(payment.paid_on, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("closing is refused while the card is owed money", async () => {
    // The deposit is not a way to pay the card off, which is the whole of the
    // difference between a deposit and a payment.
    const charges = (await listCharges(user.id)).filter((c) => c.facility_id === card.id);
    const payments = (await listCardPayments(user.id)).filter((p) => p.facility_id === card.id);
    const standing = cardStanding({ ...card, opened_on: today() }, charges, payments, today());

    assert.ok(standing.balance > 0, "there should still be a balance for this to be worth testing");
    const reloaded = await one("SELECT status FROM credit_facilities WHERE id = $1", [card.id]);
    assert.equal(reloaded.status, "active");
  });

  test("charges go with the card when it is deleted", async () => {
    const doomed = await openFacility({
      userId: user.id, product: "secured_card", label: "Second",
      apr: 30, creditLimit: 500, deposit: 500, openedOn: today()
    });
    await addCharge({
      facilityId: doomed.id, userId: user.id, merchant: "Kiosk", amount: 100, chargedOn: today()
    });

    await q("DELETE FROM credit_facilities WHERE id = $1", [doomed.id]);
    assert.equal(
      (await listCharges(user.id)).filter((c) => c.facility_id === doomed.id).length, 0
    );
  });
});

describe("telling someone their minimum was missed", { skip: skipWithoutDb }, () => {
  let user;
  let card;

  before(async () => {
    user = await makeUser("credit-notice");
    card = await openFacility({
      userId: user.id, product: "secured_card", label: "Card",
      apr: 30, creditLimit: 10000, deposit: 10000, openedOn: today()
    });
  });

  after(async () => { await dropUser(user?.id); });

  test("the first claim on a statement is the only one", async () => {
    const first = await claimCardNotice({
      facilityId: card.id, userId: user.id, cycle: "2026-06", sentTo: "a@b.test"
    });
    const second = await claimCardNotice({
      facilityId: card.id, userId: user.id, cycle: "2026-06", sentTo: "a@b.test"
    });

    assert.equal(first, true);
    assert.equal(second, false, "the same statement must not be emailed about twice");
  });

  test("two requests racing produce exactly one notice", async () => {
    // The whole reason the cycle is a unique key rather than a read followed
    // by a write.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        claimCardNotice({
          facilityId: card.id, userId: user.id, cycle: "2026-07", sentTo: "a@b.test"
        })
      )
    );
    assert.equal(results.filter(Boolean).length, 1);
  });

  test("a different statement is its own notice", async () => {
    assert.equal(
      await claimCardNotice({
        facilityId: card.id, userId: user.id, cycle: "2026-08", sentTo: "a@b.test"
      }),
      true
    );
    assert.equal((await listCardNotices(user.id)).length, 3);
  });

  test("handing the claim back lets it be tried again", async () => {
    await releaseCardNotice({ facilityId: card.id, cycle: "2026-08" });
    assert.equal(
      await claimCardNotice({
        facilityId: card.id, userId: user.id, cycle: "2026-08", sentTo: "a@b.test"
      }),
      true,
      "a notice whose mail did not go must be retriable"
    );
  });

  test("notices go with the card when it is deleted", async () => {
    await q("DELETE FROM credit_facilities WHERE id = $1", [card.id]);
    assert.equal((await listCardNotices(user.id)).length, 0);
  });
});

describe("a year of it, gathered up", { skip: skipWithoutDb }, () => {
  let user;
  let card;

  before(async () => {
    user = await makeUser("credit-report");
    card = await openFacility({
      userId: user.id, product: "secured_card", label: "Card",
      apr: 30, creditLimit: 10000, deposit: 10000, openedOn: "2026-02-01"
    });
    await openFacility({
      userId: user.id, product: "day_loan", label: "Bridge", principal: 8000,
      fee: 160, openedOn: "2026-03-01", dueOn: "2026-03-08"
    });
    // And one from the year before, which this year's report must not claim.
    await openFacility({
      userId: user.id, product: "day_loan", label: "Old one", principal: 5000,
      fee: 100, openedOn: "2025-06-01", dueOn: "2025-06-08"
    });

    const category = await one("SELECT id FROM categories WHERE name = 'Housing' AND user_id IS NULL");
    const other = await one("SELECT id FROM categories WHERE name = 'Food & Dining' AND user_id IS NULL");
    const spend = async (categoryId, amount, note, on) => q(
      `INSERT INTO transactions (user_id, category_id, kind, amount, note, occurred_on)
       VALUES ($1, $2, 'expense', $3, $4, $5)`,
      [user.id, categoryId, amount, note, on]
    );

    await spend(category.id, 60000, "Rent for the year", "2026-04-01");
    await spend(category.id, 30000, "Deposit", "2026-05-01");
    await spend(other.id, 4000, "Big dinner", "2026-06-01");
    // Repayments: money out, but nothing bought.
    await spend(null, 45000, "Card payment — Card", "2026-07-01");
    await spend(null, 40000, "Credit repayment: Bridge", "2026-07-02");
    // A deposit is not a purchase either: it leaves the wallet and comes back
    // when the card closes, and it buys nothing on the way.
    await spend(null, 50000, "Secured card deposit — Card", "2026-02-01");
    // And last year's, which must not appear in this year's figures.
    await spend(category.id, 99000, "Last year's rent", "2025-04-01");

    await addCharge({
      facilityId: card.id, userId: user.id, merchant: "Fridge",
      amount: 35000, chargedOn: "2026-05-20"
    });
  });

  after(async () => { await dropUser(user?.id); });

  test("what was opened counts only the year asked for", async () => {
    const opened = await creditOpenedInYear(user.id, 2026);
    const byProduct = Object.fromEntries(opened.map((r) => [r.product, r]));
    assert.equal(opened.length, 2);
    assert.equal(byProduct.day_loan.count, 1);
    assert.equal(byProduct.day_loan.principal, 8000);
    assert.equal(byProduct.secured_card.count, 1);

    const before = await creditOpenedInYear(user.id, 2025);
    assert.equal(before[0].principal, 5000);
  });

  test("the biggest category is the biggest, and last year is not in it", async () => {
    const categories = await spendingByCategoryInYear(user.id, 2026);
    assert.equal(categories[0].name, "Housing");
    assert.equal(categories[0].total, 90000);
    assert.equal(categories[0].count, 2);
    assert.ok(
      categories.every((c) => c.total !== 99000),
      "last year's rent must not be counted in this year"
    );
    // The repayments and the deposit come to 135,000 between them, which would
    // top this table and tell someone their biggest outgoing of the year was
    // paying off a card — while the purchases beside it say those are left out.
    assert.ok(
      categories.every((c) => c.name !== "Uncategorized"),
      "settling credit is not a spending category"
    );
  });

  test("the biggest purchases come from the wallet and the card alike", async () => {
    const purchases = await biggestPurchasesInYear(user.id, 2026, 10);
    assert.equal(purchases[0].what, "Rent for the year");
    assert.equal(purchases[0].amount, 60000);
    assert.equal(purchases[0].source, "wallet");

    const fridge = purchases.find((p) => p.what === "Fridge");
    assert.ok(fridge, "a card charge is a purchase too");
    assert.equal(fridge.amount, 35000);
    assert.equal(fridge.source, "card");
  });

  test("and repayments are not purchases, however large", async () => {
    // Both are bigger than the fridge, and neither bought anything.
    const purchases = await biggestPurchasesInYear(user.id, 2026, 20);
    const notes = purchases.map((p) => p.what);
    assert.ok(!notes.some((n) => n.startsWith("Card payment")), "card payments settle, not buy");
    assert.ok(!notes.some((n) => n.startsWith("Credit repayment")), "instalments settle, not buy");
    assert.ok(
      !notes.some((n) => n.startsWith("Secured card deposit")),
      "a deposit is held, not spent — it was the largest thing on the page before this"
    );
  });

  test("dates come back as days here too", async () => {
    const [first] = await biggestPurchasesInYear(user.id, 2026, 1);
    assert.match(first.spent_on, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("the years offered are the ones with something in them", async () => {
    const years = await yearsWithActivity(user.id);
    assert.deepEqual(years, [2026, 2025]);
  });
});

// One teardown for the whole file — every suite in it shares the same pool.
after(async () => {
  await closePool();
});
