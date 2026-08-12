import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CASE_PRIORITIES,
  caseBoard,
  caseStanding,
  isOpen,
  needsAttention,
  pipeline,
  weightedValue
} from "../../utils/crm.js";

const TODAY = "2026-08-11";
const NOW = new Date("2026-08-11T12:00:00Z");

const deal = (over = {}) => ({
  id: 1, name: "A deal", value: 1000, stage: "lead", probability: null,
  expected_close: null, updated_on: TODAY, created_on: TODAY, ...over
});

const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();
const supportCase = (over = {}) => ({
  id: 1, subject: "Something", status: "open", priority: "normal",
  created_at: hoursAgo(1), ...over
});

describe("what a deal is worth to a forecast", () => {
  test("is its value against the odds of its stage", () => {
    assert.equal(weightedValue(deal({ value: 1000, stage: "lead" })), 100);
    assert.equal(weightedValue(deal({ value: 1000, stage: "negotiation" })), 800);
  });

  test("an explicit probability beats the stage's", () => {
    assert.equal(weightedValue(deal({ value: 1000, stage: "lead", probability: 50 })), 500);
  });

  test("zero is a real answer, not a missing one", () => {
    assert.equal(weightedValue(deal({ value: 1000, probability: 0 })), 0);
  });

  test("odds outside 0–100 are pulled back into range", () => {
    assert.equal(weightedValue(deal({ value: 1000, probability: 150 })), 1000);
    assert.equal(weightedValue(deal({ value: 1000, probability: -20 })), 0);
  });

  test("a won deal is worth all of it and a lost one nothing", () => {
    assert.equal(weightedValue(deal({ value: 1000, stage: "won" })), 1000);
    assert.equal(weightedValue(deal({ value: 1000, stage: "lost" })), 0);
  });
});

describe("the pipeline", () => {
  const deals = [
    deal({ id: 1, value: 1000, stage: "lead" }),
    deal({ id: 2, value: 2000, stage: "negotiation" }),
    deal({ id: 3, value: 5000, stage: "won" }),
    deal({ id: 4, value: 3000, stage: "lost" })
  ];
  const out = pipeline(deals);

  test("counts only the live deals as pipeline", () => {
    assert.equal(out.open.count, 2);
    assert.equal(out.open.value, 3000, "the won 5000 is not pipeline");
  });

  test("weights them against their odds", () => {
    assert.equal(out.open.weighted, 1700, "100 + 1600");
  });

  test("win rate is of the deals actually decided", () => {
    assert.equal(out.winRate, 50, "one won, one lost — the open two are not evidence");
  });

  test("with nothing decided there is no rate to report", () => {
    assert.equal(pipeline([deal()]).winRate, null);
  });

  test("empty books do not divide by zero", () => {
    const empty = pipeline([]);
    assert.equal(empty.open.value, 0);
    assert.equal(empty.winRate, null);
  });

  test("groups by stage in the order deals travel", () => {
    assert.deepEqual(
      out.byStage.map((s) => s.stage),
      ["lead", "qualified", "proposal", "negotiation", "won", "lost"]
    );
  });
});

describe("deals going quiet", () => {
  test("a close date that has gone by is the urgent kind", () => {
    const out = needsAttention([deal({ expected_close: "2026-08-01" })], TODAY);
    assert.equal(out.length, 1);
    assert.equal(out[0].severity, "high");
    assert.match(out[0].reason, /gone by/);
  });

  test("untouched for weeks is worth raising more gently", () => {
    const out = needsAttention([deal({ updated_on: "2026-07-01" })], TODAY);
    assert.equal(out[0].severity, "medium");
    assert.match(out[0].reason, /41 days/);
  });

  test("a deal being worked is left alone", () => {
    assert.deepEqual(needsAttention([deal({ updated_on: "2026-08-10" })], TODAY), []);
  });

  test("closed deals are never chased", () => {
    const out = needsAttention([
      deal({ stage: "won", updated_on: "2026-01-01" }),
      deal({ stage: "lost", expected_close: "2026-01-01" })
    ], TODAY);
    assert.deepEqual(out, []);
  });

  test("the longest-idle comes first", () => {
    const out = needsAttention([
      deal({ id: 1, updated_on: "2026-07-15" }),
      deal({ id: 2, updated_on: "2026-06-01" })
    ], TODAY);
    assert.equal(out[0].id, 2);
  });
});

describe("whether a case is late", () => {
  test("an urgent case has hours, not days", () => {
    assert.equal(CASE_PRIORITIES.urgent.hours, 4);
    const out = caseStanding(supportCase({ priority: "urgent", created_at: hoursAgo(6) }), NOW);
    assert.equal(out.late, true);
    assert.equal(out.overBy, 2);
  });

  test("the same age on a normal case is not late at all", () => {
    const out = caseStanding(supportCase({ priority: "normal", created_at: hoursAgo(6) }), NOW);
    assert.equal(out.late, false);
  });

  test("waiting on the customer stops the clock", () => {
    const out = caseStanding(
      supportCase({ priority: "urgent", status: "pending", created_at: hoursAgo(100) }), NOW
    );
    assert.equal(out.late, false);
    assert.equal(out.waiting, true);
  });

  test("a settled case is never late", () => {
    const out = caseStanding(
      supportCase({ priority: "urgent", status: "resolved", created_at: hoursAgo(100) }), NOW
    );
    assert.equal(out.late, false);
    assert.equal(out.settled, true);
  });

  test("age reads in hours then in days", () => {
    assert.equal(caseStanding(supportCase({ created_at: hoursAgo(5) }), NOW).ageLabel, "5h");
    assert.equal(caseStanding(supportCase({ created_at: hoursAgo(72) }), NOW).ageLabel, "3d");
  });
});

describe("the support desk, in the order to work it", () => {
  const cases = [
    supportCase({ id: 1, priority: "low", created_at: hoursAgo(2) }),
    supportCase({ id: 2, priority: "urgent", created_at: hoursAgo(10) }),
    supportCase({ id: 3, priority: "normal", status: "resolved", created_at: hoursAgo(1) }),
    supportCase({ id: 4, priority: "high", created_at: hoursAgo(2) })
  ];
  const board = caseBoard(cases, NOW);

  test("the late one comes first", () => {
    assert.equal(board.rows[0].id, 2);
    assert.equal(board.rows[0].standing.late, true);
  });

  test("then by priority among those still within target", () => {
    assert.equal(board.rows[1].id, 4, "high before low");
    assert.equal(board.rows[2].id, 1);
  });

  test("settled cases sink to the bottom rather than vanishing", () => {
    assert.equal(board.rows.at(-1).id, 3);
    assert.equal(board.rows.length, 4);
  });

  test("counts what a desk is judged on", () => {
    assert.equal(board.counts.total, 4);
    assert.equal(board.counts.late, 1);
    assert.equal(board.counts.settled, 1);
    assert.equal(board.active.length, 3);
  });
});

describe("which stages are live", () => {
  test("everything up to a decision", () => {
    assert.equal(isOpen("lead"), true);
    assert.equal(isOpen("negotiation"), true);
    assert.equal(isOpen("won"), false);
    assert.equal(isOpen("lost"), false);
  });

  test("and nonsense is not a stage", () => {
    assert.equal(isOpen("maybe"), false);
  });
});
