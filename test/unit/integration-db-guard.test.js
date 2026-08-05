// The integration suites skip themselves when there is no database. Twice now
// that skip has swallowed tests that were supposed to run — a schema that would
// not build, then a first connection that took longer than the probe allowed —
// and both times the run stayed green, because node's totals report a file that
// skipped itself exactly like one that passed.
//
// So: a database that is named but cannot be reached must fail. This spawns the
// helper the integration files import, rather than reaching into it, because
// the decision is made once as that module is evaluated.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { before, describe, test } from "node:test";

const helpers = new URL("../integration/helpers.js", import.meta.url).href;

describe("the integration helpers", () => {
  let loaded;

  before(() => {
    loaded = spawnSync(
      process.execPath,
      ["-e", `import(${JSON.stringify(helpers)})`],
      {
        // A connection string beats the DB_* variables in db/index.js, so this
        // points the child at nothing whatever the machine running it is set
        // up with — a developer's .env, or CI's own database.
        env: { ...process.env, DATABASE_URL: "postgres://nobody@127.0.0.1:1/nothing" },
        encoding: "utf8",
        timeout: 120_000
      }
    );
  });

  test("fail rather than skip when the database cannot be reached", () => {
    assert.notEqual(loaded.status, 0, "a database that cannot be reached must fail the run");
    assert.match(loaded.stderr, /could not be reached/);
    assert.match(loaded.stderr, /not an absent database/);
  });

  test("say which variables named the database they could not reach", () => {
    assert.match(loaded.stderr, /configured by: DATABASE_URL/);
  });
});
