import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { performRun, runAutopay, gather } from "../../controllers/card-agent.controller.js";
import {
  addRedemption,
  claimDailyRun,
  getAgentSettings,
  listAgentPayments,
  listRedemptions,
  releaseDailyRun,
  saveAgentSettings
} from "../../db/queries/card-agent.js";
import {
  addCardPayment,
  addCharge,
  listCardPayments,
  listCharges,
  openFacility,
  raiseCardLimit
} from "../../db/queries/credit.js";
import { cardStanding } from "../../utils/credit.js";
import { pointsStanding } from "../../utils/cards.js";
import { closePool, dropUser, makeUser, one, q, skipWithoutDb } from "./helpers.js";

// The card is opened in June and charged in July, so July's statement is drawn
// on the 31st and falls due on 21 August. Every date below is fixed for that
// reason: an agent that pays before a date can only be tested from a day with a
// known relationship to one.
const OPENED_ON = "2026-06-01";
const CHARGED_ON = "2026-07-05";
const DUE_ON = "2026-08-21";
const TWO_DAYS_BEFORE = "2026-08-19";

async function seedLedger(userId) {
  const category = await one(
    "SELECT id FROM categories WHERE user_id IS NULL AND kind = 'income' LIMIT 1"
  );
  for (let back = 0; back < 3; back++) {
    await q(
      `INSERT INTO transactions (user_id, category_id, kind, amount, note, occurred_on)
       VALUES ($1, $2, 'income', 90000, 'Salary',
               (date_trunc('month', CURRENT_DATE) - make_interval(months => $3))::date)`,
      [userId, category.id, back]
    );
  }
}

async function makeWallet(userId, balance) {
  return one(
    `INSERT INTO accounts (user_id, name, type, balance)
     VALUES ($1, 'M-Pesa', 'mobile', $2)
     RETURNING *`,
    [userId, balance]
  );
}

async function openCard(userId, over = {}) {
  return openFacility({
    userId,
    product: "secured_card",
    label: "Everyday card",
    apr: 30,
    creditLimit: 50000,
    deposit: 50000,
    openedOn: OPENED_ON,
    ...over
  });
}

const walletBalance = async (id) =>
  Number((await one("SELECT balance FROM accounts WHERE id = $1", [id])).balance);

describe("the agent paying a card by itself", { skip: skipWithoutDb }, () => {
  let user;
  let wallet;
  let card;

  before(async () => {
    user = await makeUser("agent-autopay");
    await seedLedger(user.id);
    wallet = await makeWallet(user.id, 90000);
    card = await openCard(user.id);
    await addCharge({
      facilityId: card.id, userId: user.id, merchant: "Naivas",
      amount: 20000, chargedOn: CHARGED_ON
    });
    await saveAgentSettings({
      userId: user.id,
      autopay: "minimum",
      autopayAccountId: wallet.id,
      leadDays: 3,
      utilisationTarget: 30,
      chargeGuard: false,
      alertEmail: null
    });
  });

  after(async () => { await dropUser(user?.id); });

  test("pays the minimum out of the chosen wallet before the date", async () => {
    const before = await walletBalance(wallet.id);
    const { review } = await gather(user, TWO_DAYS_BEFORE);
    const actions = await runAutopay({ user, review, todayIso: TWO_DAYS_BEFORE });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].kind, "paid");
    assert.equal(actions[0].amount, review.cards[0].card.minimumDue);
    assert.equal(await walletBalance(wallet.id), before - actions[0].amount);
  });

  test("the payment says the agent made it, and carries the expense with it", async () => {
    const [payment] = await listCardPayments(user.id);
    assert.equal(payment.source, "agent");
    assert.ok(payment.transaction_id, "an agent payment is still money leaving a wallet");

    const transaction = await one(
      "SELECT note, kind FROM transactions WHERE id = $1",
      [payment.transaction_id]
    );
    assert.equal(transaction.kind, "expense");
    assert.match(transaction.note, /card agent/i);
  });

  test("and the statement it settled comes off the balance", async () => {
    const [charges, payments] = await Promise.all([listCharges(user.id), listCardPayments(user.id)]);
    const standing = cardStanding(
      { ...card, opened_on: OPENED_ON }, charges, payments, TWO_DAYS_BEFORE
    );
    assert.equal(standing.statement, null, "nothing is still asking to be paid");
  });

  test("running again does not pay the same cycle twice", async () => {
    const before = await walletBalance(wallet.id);
    const { review } = await gather(user, TWO_DAYS_BEFORE);
    const actions = await runAutopay({ user, review, todayIso: TWO_DAYS_BEFORE });

    assert.deepEqual(actions, []);
    assert.equal(await walletBalance(wallet.id), before);
    assert.equal((await listAgentPayments(user.id)).length, 1);
  });

  test("what it paid is kept where the holder can see it", async () => {
    const [paid] = await listAgentPayments(user.id);
    assert.equal(paid.cycle, "2026-07");
    assert.equal(paid.kind, "minimum");
    assert.equal(paid.label, "Everyday card");
  });
});

describe("the agent held back", { skip: skipWithoutDb }, () => {
  let user;
  let wallet;

  before(async () => {
    user = await makeUser("agent-held");
    await seedLedger(user.id);
    wallet = await makeWallet(user.id, 100);
    const card = await openCard(user.id);
    await addCharge({
      facilityId: card.id, userId: user.id, merchant: "Naivas",
      amount: 20000, chargedOn: CHARGED_ON
    });
  });

  after(async () => { await dropUser(user?.id); });

  test("pays nothing at all while autopay is off", async () => {
    await saveAgentSettings({
      userId: user.id, autopay: "off", autopayAccountId: wallet.id,
      leadDays: 3, utilisationTarget: 30, chargeGuard: false, alertEmail: null
    });

    const { review } = await gather(user, TWO_DAYS_BEFORE);
    assert.deepEqual(await runAutopay({ user, review, todayIso: TWO_DAYS_BEFORE }), []);
    assert.equal((await listCardPayments(user.id)).length, 0);
  });

  test("takes nothing from a wallet that will not cover it, and says so", async () => {
    await saveAgentSettings({
      userId: user.id, autopay: "minimum", autopayAccountId: wallet.id,
      leadDays: 3, utilisationTarget: 30, chargeGuard: false, alertEmail: null
    });

    const { review } = await gather(user, TWO_DAYS_BEFORE);
    const actions = await runAutopay({ user, review, todayIso: TWO_DAYS_BEFORE });

    assert.equal(actions[0].kind, "short");
    assert.equal(await walletBalance(wallet.id), 100);
    assert.equal((await listCardPayments(user.id)).length, 0);
    // Nothing was claimed either, so the next run tries again rather than
    // recording a cycle as paid that was not.
    assert.equal((await listAgentPayments(user.id)).length, 0);
  });

  test("waits while the date is still far off", async () => {
    const { review } = await gather(user, "2026-08-11");
    assert.deepEqual(await runAutopay({ user, review, todayIso: "2026-08-11" }), []);
  });
});

describe("a full run", { skip: skipWithoutDb }, () => {
  let user;

  before(async () => {
    user = await makeUser("agent-run");
    await seedLedger(user.id);
    const wallet = await makeWallet(user.id, 90000);
    const card = await openCard(user.id);
    await addCharge({
      facilityId: card.id, userId: user.id, merchant: "Naivas",
      amount: 41000, chargedOn: CHARGED_ON, categoryId: null
    });
    await saveAgentSettings({
      userId: user.id, autopay: "off", autopayAccountId: wallet.id,
      leadDays: 3, utilisationTarget: 30, chargeGuard: false, alertEmail: null
    });
  });

  after(async () => { await dropUser(user?.id); });

  test("is written down with the figures it was made from", async () => {
    const outcome = await performRun(user, TWO_DAYS_BEFORE);

    assert.ok(outcome.saved.id);
    assert.equal(outcome.saved.mode, "offline", "no provider is configured in tests");
    assert.equal(Number(outcome.saved.balance), outcome.review.balance);
    assert.equal(outcome.saved.moves_total, outcome.review.counts.total);
    assert.ok(outcome.saved.narrative.length > 0);
  });

  test("and the moves are kept as they were, not recomputed later", async () => {
    const row = await one(
      "SELECT moves FROM card_agent_runs WHERE user_id = $1 ORDER BY id DESC LIMIT 1",
      [user.id]
    );
    assert.ok(Array.isArray(row.moves));
    assert.ok(row.moves.some((m) => m.kind === "due"));
    assert.ok(row.moves.some((m) => m.kind === "maxed"));
  });

  test("the daily round is claimed once, and not again the same day", async () => {
    await q("UPDATE card_agent_settings SET last_run_on = NULL WHERE user_id = $1", [user.id]);

    assert.equal(await claimDailyRun(user.id), true, "the first caller gets the day");
    assert.equal(await claimDailyRun(user.id), false, "and every other one is told no");

    const settings = await getAgentSettings(user.id);
    assert.ok(settings.last_run_on, "the day it ran is recorded");
  });

  test("a round handed back is available again", async () => {
    await releaseDailyRun(user.id, null);
    assert.equal(await claimDailyRun(user.id), true);
  });
});

describe("points off a balance", { skip: skipWithoutDb }, () => {
  let user;
  let card;

  before(async () => {
    user = await makeUser("agent-points");
    await seedLedger(user.id);
    card = await openCard(user.id, { creditLimit: 200000, deposit: 200000 });
    await addCharge({
      facilityId: card.id, userId: user.id, merchant: "Naivas",
      amount: 60000, chargedOn: "2026-08-02"
    });
  });

  after(async () => { await dropUser(user?.id); });

  test("are earned from the charges, at the card's own rate", async () => {
    const charges = await listCharges(user.id);
    assert.equal(pointsStanding("secured_card", charges, []).earned, 600);
  });

  test("redeeming moves the balance without moving money", async () => {
    const payment = await addCardPayment({
      facilityId: card.id, userId: user.id, amount: 600,
      paidOn: "2026-08-05", transactionId: null, source: "points"
    });
    await addRedemption({
      facilityId: card.id, userId: user.id, points: 600, amount: 600,
      paymentId: payment.id, redeemedOn: "2026-08-05"
    });

    const [charges, payments] = await Promise.all([listCharges(user.id), listCardPayments(user.id)]);
    const standing = cardStanding(
      { ...card, opened_on: OPENED_ON }, charges, payments, "2026-08-11"
    );
    assert.equal(standing.balance, 59400);
    assert.equal(payments[0].source, "points");
    assert.equal(payments[0].transaction_id, null, "no money left a wallet");
  });

  test("and comes off the points balance, so it cannot be spent twice", async () => {
    const [charges, redemptions] = await Promise.all([
      listCharges(user.id),
      listRedemptions(user.id)
    ]);
    const points = pointsStanding("secured_card", charges, redemptions);
    assert.equal(points.earned, 600);
    assert.equal(points.redeemed, 600);
    assert.equal(points.balance, 0);
  });

  test("the history says which card the points came off", async () => {
    const [row] = await listRedemptions(user.id);
    assert.equal(row.label, "Everyday card");
    assert.equal(row.card_status, "active");
    assert.equal(row.redeemed_on, "2026-08-05");
  });

  test("and keeps saying so after the card is closed", async () => {
    await q("UPDATE credit_facilities SET status = 'closed' WHERE id = $1", [card.id]);
    try {
      const [row] = await listRedemptions(user.id);
      assert.equal(row.label, "Everyday card", "a redemption still happened");
      assert.equal(row.card_status, "closed");
    } finally {
      await q("UPDATE credit_facilities SET status = 'active' WHERE id = $1", [card.id]);
    }
  });
});

describe("raising a limit", { skip: skipWithoutDb }, () => {
  let user;
  let secured;
  let unsecured;

  before(async () => {
    user = await makeUser("agent-limit");
    await seedLedger(user.id);
    secured = await openCard(user.id);
    unsecured = await openFacility({
      userId: user.id, product: "gold_card", label: "Gold",
      apr: 18, creditLimit: 40000, deposit: null, openedOn: OPENED_ON
    });
  });

  after(async () => { await dropUser(user?.id); });

  test("only ever goes up", async () => {
    assert.ok(await raiseCardLimit({ facilityId: unsecured.id, userId: user.id, limit: 80000 }));
    assert.equal(
      await raiseCardLimit({ facilityId: unsecured.id, userId: user.id, limit: 60000 }),
      null,
      "lowering a limit under money already spent is not somebody's own doing"
    );
  });

  test("and never on a secured card, whose limit is the deposit", async () => {
    assert.equal(
      await raiseCardLimit({ facilityId: secured.id, userId: user.id, limit: 90000 }),
      null
    );
  });

  test("not on somebody else's card either", async () => {
    const other = await makeUser("agent-limit-other");
    try {
      assert.equal(
        await raiseCardLimit({ facilityId: unsecured.id, userId: other.id, limit: 999999 }),
        null
      );
    } finally {
      await dropUser(other.id);
    }
  });
});

after(async () => { await closePool(); });
