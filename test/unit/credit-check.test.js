import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { checkStatus, isUsable, PURPOSES, sharedHistory } from "../../utils/credit-check.js";

const TODAY = "2026-08-07";

describe("whether a check still works", () => {
  test("an unexpired, unrevoked one does", () => {
    const check = { expires_on: "2026-09-01", revoked_at: null };
    assert.equal(checkStatus(check, TODAY), "active");
    assert.equal(isUsable(check, TODAY), true);
  });

  test("it works on its last day, not up to it", () => {
    assert.equal(checkStatus({ expires_on: TODAY, revoked_at: null }, TODAY), "active");
    assert.equal(checkStatus({ expires_on: "2026-08-06", revoked_at: null }, TODAY), "expired");
  });

  test("stopping it beats the date it would have run to", () => {
    // Revoked is the more deliberate of the two and the one the person will be
    // looking for when they check that stopping it worked.
    const check = { expires_on: "2026-12-01", revoked_at: new Date() };
    assert.equal(checkStatus(check, TODAY), "revoked");
    assert.equal(isUsable(check, TODAY), false);
  });

  test("a stopped one that has also run out still reads as stopped", () => {
    const check = { expires_on: "2026-01-01", revoked_at: new Date() };
    assert.equal(checkStatus(check, TODAY), "revoked");
  });
});

describe("what a lender is handed", () => {
  const facilities = [
    {
      product: "secured_card", status: "active", opened_on: "2026-01-01",
      label: "My private name for this", credit_limit: 10000,
      standing: { outstanding: 0 },
      card: {
        balance: 2000, utilisation: 20, statements: [
          { cycle: "2026-06", dueOn: "2026-07-21", minimumDue: 100, met: true, missed: false }
        ]
      },
      installments: []
    },
    {
      product: "bnpl", status: "settled", opened_on: "2026-02-01",
      label: "Washing machine", standing: { outstanding: 0 },
      installments: [
        { due_on: "2026-03-05", paid_on: "2026-03-04", amount: 4000 },
        { due_on: "2026-04-05", paid_on: "2026-04-09", amount: 4000 }
      ]
    }
  ];

  const history = sharedHistory({ facilities, monthlyIncome: 50000, todayIso: TODAY });

  test("what is owed, and on what", () => {
    assert.equal(history.owed, 2000);
    assert.equal(history.owedOnCards, 2000);
    assert.equal(history.owedOnPlans, 0);
  });

  test("the payment record over every year, not one", () => {
    // A single year can flatter or damn a record that years of it would not.
    assert.equal(history.record.due, 3);
    assert.equal(history.record.onTime, 2);
    assert.equal(history.record.late, 1);
  });

  test("a standing, scored the same way the owner sees it", () => {
    assert.equal(typeof history.score.score, "number");
    assert.ok(history.score.parts.length > 0);
  });

  test("one line per account, and how many were settled", () => {
    assert.equal(history.accounts.length, 2);
    assert.equal(history.openedCount, 2);
    assert.equal(history.settledCount, 1);
    assert.deepEqual(
      history.accounts.map((a) => a.product),
      ["secured_card", "bnpl"]
    );
  });

  test("but never what the person called anything", () => {
    // A label is whatever they typed — "Mum's operation", "divorce lawyer".
    // A lender deciding on a mortgage has no business with it.
    const serialised = JSON.stringify(history);
    assert.doesNotMatch(serialised, /My private name for this/);
    assert.doesNotMatch(serialised, /Washing machine/);
    assert.ok(history.accounts.every((a) => !("label" in a)));
  });

  test("and nothing about spending, balances or contact", () => {
    const serialised = JSON.stringify(history);
    for (const leak of ["categories", "purchases", "accountsBalance", "email", "transactions"]) {
      assert.doesNotMatch(serialised, new RegExp(`"${leak}"`));
    }
  });

  test("it says what it is holding back, so the lender knows there is more", () => {
    assert.ok(history.withheld.length >= 3);
    assert.ok(history.withheld.some((w) => /spend/i.test(w)));
  });

  test("somebody with nothing gets a page saying so, not a zero", () => {
    const empty = sharedHistory({ facilities: [], monthlyIncome: 0, todayIso: TODAY });
    assert.equal(empty.owed, 0);
    assert.equal(empty.score.score, null);
    assert.equal(empty.historyMonths, 0);
  });
});

describe("the purposes on offer", () => {
  test("cover the borrowing this app does not do", () => {
    assert.deepEqual(
      Object.keys(PURPOSES),
      ["mortgage", "car_loan", "business_loan", "other"]
    );
  });
});
