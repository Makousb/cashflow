import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  addCardPayment,
  addCharge,
  claimCardNotice,
  closeFacility,
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
  settleInstallment
} from "../../db/queries/credit.js";
import { affordability, assessCharge, assessDayLoan, cardStanding } from "../../utils/credit.js";
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

// One teardown for the whole file — every suite in it shares the same pool.
after(async () => {
  await closePool();
});
