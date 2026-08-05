import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { listGoals } from "../../db/queries/goals.js";
import { listReceiptsForAnalytics } from "../../db/queries/receipts.js";
import { listTransactionsForAnalytics } from "../../db/queries/transactions.js";
import { toGoalPayload } from "../../services/analytics.js";
import { today } from "../../utils/dates.js";
import { closePool, dropUser, makeUser, q, skipWithoutDb } from "./helpers.js";

// The analytics service reads every date with date.fromisoformat, which has no
// timezone in it and wants a bare YYYY-MM-DD. So each date is made into a day
// before it leaves here — to_char in the SQL, toISODate for the goals — and
// never handed over as a Date for the JSON encoder to turn into a UTC instant.
// That is a convention held up by nothing except the queries remembering it,
// and a field added later would not fail here: Python raises on the instant it
// would receive, and month_key, which only slices the first seven characters,
// would not raise at all. It would simply file the day under the wrong month.
describe("what the analytics service is sent", { skip: skipWithoutDb }, () => {
  let user;
  // Dated today, so this catches a timezone and not only a format: a date put
  // back through a Date lands on the day before wherever local time runs ahead
  // of UTC, which is most of the world and one of the CI legs.
  const day = today();

  before(async () => {
    user = await makeUser("analytics");
    await q(
      `INSERT INTO transactions (user_id, kind, amount, occurred_on)
       VALUES ($1, 'expense', 500, $2)`,
      [user.id, day]
    );
    await q(
      `INSERT INTO receipts (user_id, filename, merchant, total, purchased_on)
       VALUES ($1, 'receipt.jpg', 'Mama Njeri Grocers', 500, $2)`,
      [user.id, day]
    );
    await q(
      `INSERT INTO goals (user_id, name, target_amount, target_date)
       VALUES ($1, 'New fridge', 50000, $2)`,
      [user.id, day]
    );
  });

  after(async () => {
    await dropUser(user?.id);
  });

  // As it goes over the wire rather than as it sits in memory. A Date passes
  // every check you can make on the object and only becomes
  // "2026-08-04T21:00:00.000Z" once JSON.stringify reaches it, which is the
  // form the service would actually be given.
  const onTheWire = async () =>
    JSON.parse(
      JSON.stringify({
        today: day,
        transactions: await listTransactionsForAnalytics(user.id, 6),
        receipts: await listReceiptsForAnalytics(user.id, 6),
        goals: toGoalPayload(await listGoals(user.id))
      })
    );

  const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

  test("every date in it is a plain calendar day", async () => {
    const wire = await onTheWire();
    assert.match(wire.today, DAY_ONLY, "the reference date");
    assert.match(wire.transactions[0].occurred_on, DAY_ONLY, "transactions");
    assert.match(wire.receipts[0].purchased_on, DAY_ONLY, "receipts");
    assert.match(wire.goals[0].target_date, DAY_ONLY, "goals");
  });

  test("and it is the day that went in", async () => {
    const wire = await onTheWire();
    assert.equal(wire.transactions[0].occurred_on, day);
    assert.equal(wire.receipts[0].purchased_on, day);
    assert.equal(wire.goals[0].target_date, day);
  });
});

// One teardown for the whole file — every suite in it shares the same pool.
after(async () => {
  await closePool();
});
