import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  backfillJournals,
  ensureChart,
  ledgerLines,
  listAccounts,
  listEntries,
  postEntry,
  postEntryAlone,
  unpostedCount
} from "../../db/queries/ledger.js";
import { addBusinessTransaction } from "../../db/queries/business.js";
import { createBill, createInvoice, markInvoicePaid } from "../../db/queries/accounting.js";
import { createSale } from "../../db/queries/sales.js";
import { invoicePaidEntry, trialBalance } from "../../utils/ledger.js";
import { pool } from "../../db/index.js";
import {
  closePool, dropUser, makeBusiness, makeProduct, makeUser, one, q, skipWithoutDb
} from "./helpers.js";

const TODAY = "2026-08-11";

// The trial balance as the app would compute it, straight from the rows.
async function trialFor(businessId, userId) {
  const [accounts, lines] = await Promise.all([
    listAccounts(businessId, userId),
    ledgerLines(businessId, userId)
  ]);
  return trialBalance(accounts, lines);
}

const balanceOf = (trial, key) => trial.rows.find((r) => r.key === key)?.balance ?? 0;

describe("opening a set of books", { skip: skipWithoutDb }, () => {
  let user;
  let business;

  before(async () => {
    user = await makeUser("ledger-chart");
    business = await makeBusiness(user.id, "Chart Co");
  });
  after(async () => { await dropUser(user?.id); });

  test("a business starts with a full chart of accounts", async () => {
    const accounts = await listAccounts(business.id, user.id);
    assert.ok(accounts.length >= 20);
    for (const key of ["cash", "accounts_receivable", "inventory", "accounts_payable",
                       "sales_revenue", "cogs"]) {
      assert.ok(accounts.some((a) => a.key === key), `missing ${key}`);
    }
  });

  test("opening it again adds nothing", async () => {
    const before = (await listAccounts(business.id, user.id)).length;
    await ensureChart(business.id, user.id);
    assert.equal((await listAccounts(business.id, user.id)).length, before);
  });

  test("an empty ledger still balances", async () => {
    const trial = await trialFor(business.id, user.id);
    assert.equal(trial.balanced, true);
    assert.equal(trial.debits, 0);
  });
});

describe("what each money path posts", { skip: skipWithoutDb }, () => {
  let user;
  let business;

  before(async () => {
    user = await makeUser("ledger-paths");
    business = await makeBusiness(user.id, "Posting Co");
  });
  after(async () => { await dropUser(user?.id); });

  test("a bookkeeping entry posts both halves", async () => {
    await addBusinessTransaction({
      businessId: business.id, userId: user.id, kind: "expense",
      amount: 200, category: "Rent", note: "August rent", occurredOn: TODAY
    });

    const trial = await trialFor(business.id, user.id);
    assert.equal(balanceOf(trial, "rent_expense"), 200);
    assert.equal(balanceOf(trial, "cash"), -200);
    assert.equal(trial.balanced, true);
  });

  test("buying stock debits the asset, never an expense", async () => {
    await addBusinessTransaction({
      businessId: business.id, userId: user.id, kind: "expense",
      amount: 800, category: "Inventory Purchase", note: "Stock", occurredOn: TODAY
    });

    const trial = await trialFor(business.id, user.id);
    assert.equal(balanceOf(trial, "inventory"), 800);
  });

  test("raising an invoice earns revenue and creates a receivable", async () => {
    await createInvoice({
      businessId: business.id, userId: user.id, customer: "Acme",
      amount: 1000, category: "Sales", issuedOn: TODAY, dueOn: null, note: null
    });

    const trial = await trialFor(business.id, user.id);
    assert.equal(balanceOf(trial, "accounts_receivable"), 1000);
    assert.equal(balanceOf(trial, "sales_revenue"), 1000);
  });

  test("settling it turns the debt into cash WITHOUT booking revenue twice", async () => {
    const invoice = await one(
      "SELECT * FROM invoices WHERE business_id = $1 LIMIT 1", [business.id]
    );

    const transaction = await addBusinessTransaction({
      businessId: business.id, userId: user.id, kind: "income",
      amount: Number(invoice.amount), category: invoice.category,
      note: `Invoice paid: ${invoice.customer}`, occurredOn: TODAY,
      entry: invoicePaidEntry({ amount: Number(invoice.amount) })
    });
    await markInvoicePaid(invoice.id, user.id, TODAY, transaction.id);

    const trial = await trialFor(business.id, user.id);
    assert.equal(balanceOf(trial, "accounts_receivable"), 0, "the debt is cleared");
    assert.equal(balanceOf(trial, "sales_revenue"), 1000, "still 1000, not 2000");
  });

  test("a bill incurs its cost when it arrives", async () => {
    await createBill({
      businessId: business.id, userId: user.id, vendor: "KPLC",
      amount: 300, category: "Utilities", issuedOn: TODAY, dueOn: null, note: null
    });

    const trial = await trialFor(business.id, user.id);
    assert.equal(balanceOf(trial, "utilities_expense"), 300);
    assert.equal(balanceOf(trial, "accounts_payable"), 300);
  });

  test("through all of it the ledger balances", async () => {
    const trial = await trialFor(business.id, user.id);
    assert.equal(trial.balanced, true);
    assert.equal(trial.difference, 0);
  });
});

describe("a sale", { skip: skipWithoutDb }, () => {
  let user;
  let business;
  let product;

  before(async () => {
    user = await makeUser("ledger-sale");
    business = await makeBusiness(user.id, "Till Co");
    product = await makeProduct(business.id, user.id, {
      name: "Sugar", quantity: 100, unitCost: 30, salePrice: 50
    });
  });
  after(async () => { await dropUser(user?.id); });

  test("books the revenue and relieves the stock that left", async () => {
    await createSale({
      businessId: business.id, userId: user.id, customer: "Walk-in",
      payment: "cash", occurredOn: TODAY,
      lines: [{ productId: product.id, name: "Sugar", quantity: 10 }]
    });

    const trial = await trialFor(business.id, user.id);
    assert.equal(balanceOf(trial, "cash"), 500, "10 at 50");
    assert.equal(balanceOf(trial, "sales_revenue"), 500);
    assert.equal(balanceOf(trial, "cogs"), 300, "10 at the 30 they cost");
    assert.equal(balanceOf(trial, "inventory"), -300, "stock left the shelves");
    assert.equal(trial.balanced, true);
  });

  test("on credit it raises a receivable rather than taking cash", async () => {
    await createSale({
      businessId: business.id, userId: user.id, customer: "Acme",
      payment: "credit", occurredOn: TODAY, dueOn: null,
      lines: [{ productId: product.id, name: "Sugar", quantity: 4 }]
    });

    const trial = await trialFor(business.id, user.id);
    assert.equal(balanceOf(trial, "accounts_receivable"), 200);
    assert.equal(balanceOf(trial, "cash"), 500, "unchanged by a credit sale");
    assert.equal(trial.balanced, true);
  });
});

describe("what the ledger refuses", { skip: skipWithoutDb }, () => {
  let user;
  let business;

  before(async () => {
    user = await makeUser("ledger-refuse");
    business = await makeBusiness(user.id, "Refusal Co");
  });
  after(async () => { await dropUser(user?.id); });

  test("an entry whose sides disagree is not written at all", async () => {
    await assert.rejects(
      postEntryAlone({
        businessId: business.id, userId: user.id, entryDate: TODAY,
        lines: [
          { account: "cash", debit: 100, credit: 0 },
          { account: "sales_revenue", debit: 0, credit: 90 }
        ]
      }),
      /unbalanced/
    );

    assert.equal((await listEntries(business.id, user.id)).length, 0, "nothing was left behind");
    assert.equal((await ledgerLines(business.id, user.id)).length, 0);
  });

  test("and the database refuses a line carrying both sides, even by hand", async () => {
    const account = (await listAccounts(business.id, user.id)).find((a) => a.key === "cash");
    const entry = await postEntryAlone({
      businessId: business.id, userId: user.id, entryDate: TODAY,
      lines: [
        { account: "cash", debit: 10, credit: 0 },
        { account: "sales_revenue", debit: 0, credit: 10 }
      ]
    });

    await assert.rejects(
      pool.query(
        "INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 5, 5)",
        [entry.id, account.id]
      ),
      /violates check constraint/
    );
  });

  test("one source event cannot be posted twice", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const first = await postEntry(client, {
        businessId: business.id, userId: user.id, entryDate: TODAY, source: "sale", sourceId: 4242,
        lines: [
          { account: "cash", debit: 25, credit: 0 },
          { account: "sales_revenue", debit: 0, credit: 25 }
        ]
      });
      const again = await postEntry(client, {
        businessId: business.id, userId: user.id, entryDate: TODAY, source: "sale", sourceId: 4242,
        lines: [
          { account: "cash", debit: 25, credit: 0 },
          { account: "sales_revenue", debit: 0, credit: 25 }
        ]
      });
      await client.query("COMMIT");

      assert.ok(first, "the first one posts");
      assert.equal(again, null, "the second is told no rather than duplicating it");
    } finally {
      client.release();
    }
  });
});

describe("catching the ledger up with older books", { skip: skipWithoutDb }, () => {
  let user;
  let business;

  before(async () => {
    user = await makeUser("ledger-backfill");
    business = await makeBusiness(user.id, "History Co");

    // Written the way the seed script writes them: straight in, no journal.
    for (const [kind, amount, category] of [
      ["income", 5000, "Sales"],
      ["expense", 1200, "Rent"],
      ["expense", 2000, "Inventory Purchase"]
    ]) {
      await q(
        `INSERT INTO business_transactions
           (business_id, user_id, kind, amount, category, note, occurred_on)
         VALUES ($1, $2, $3, $4, $5, 'history', $6)`,
        [business.id, user.id, kind, amount, category, TODAY]
      );
    }
  });
  after(async () => { await dropUser(user?.id); });

  test("counts what has no journal behind it", async () => {
    assert.equal(await unpostedCount(business.id, user.id), 3);
  });

  test("posts every one of them from its own category", async () => {
    const { posted } = await backfillJournals(business.id, user.id);
    assert.equal(posted, 3);

    const trial = await trialFor(business.id, user.id);
    assert.equal(balanceOf(trial, "sales_revenue"), 5000);
    assert.equal(balanceOf(trial, "rent_expense"), 1200);
    assert.equal(balanceOf(trial, "inventory"), 2000);
    assert.equal(balanceOf(trial, "cash"), 1800, "5000 in, 3200 out");
    assert.equal(trial.balanced, true);
  });

  test("and running it again adds nothing", async () => {
    const { posted } = await backfillJournals(business.id, user.id);
    assert.equal(posted, 0);
    assert.equal(await unpostedCount(business.id, user.id), 0);
  });
});

after(async () => { await closePool(); });
