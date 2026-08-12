import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  addCaseMessage,
  createCase,
  createOpportunity,
  deleteOpportunity,
  getCase,
  listCases,
  listOpportunities,
  moveOpportunity,
  pickableContacts,
  setCaseStatus
} from "../../db/queries/crm.js";
import { caseBoard, pipeline } from "../../utils/crm.js";
import { closePool, dropUser, makeBusiness, makeUser, one, q, skipWithoutDb } from "./helpers.js";

async function makeContact(businessId, userId, email) {
  return one(
    `INSERT INTO contacts (business_id, user_id, email, name, unsubscribe_token)
     VALUES ($1, $2, $3, 'Ada Lovelace', md5(random()::text))
     RETURNING *`,
    [businessId, userId, email]
  );
}

const eventsFor = (contactId) =>
  q("SELECT kind, detail FROM contact_events WHERE contact_id = $1 ORDER BY id", [contactId]);

// By name, never by position: listOpportunities sorts newest-first, so "the
// first row" silently changes meaning the moment another deal is added.
const dealNamed = async (businessId, userId, name) =>
  (await listOpportunities(businessId, userId)).find((d) => d.name === name);

describe("the pipeline", { skip: skipWithoutDb }, () => {
  let user;
  let business;
  let contact;

  before(async () => {
    user = await makeUser("crm-pipeline");
    business = await makeBusiness(user.id, "Deals Co");
    contact = await makeContact(business.id, user.id, "ada@example.test");
  });
  after(async () => { await dropUser(user?.id); });

  test("a deal can be opened against a contact", async () => {
    await createOpportunity({
      businessId: business.id, userId: user.id, contactId: contact.id,
      name: "Monthly supply", value: 50000, stage: "qualified"
    });

    const [deal] = await listOpportunities(business.id, user.id);
    assert.equal(deal.name, "Monthly supply");
    assert.equal(deal.value, 50000);
    assert.equal(deal.contact_name, "Ada Lovelace");
  });

  test("and it lands on that contact's timeline", async () => {
    const events = await eventsFor(contact.id);
    assert.ok(events.some((e) => e.kind === "deal" && /Deal opened/.test(e.detail)));
  });

  test("a deal with nobody on file is ordinary, not an error", async () => {
    const deal = await createOpportunity({
      businessId: business.id, userId: user.id,
      name: "Walk-in enquiry", value: 3000
    });
    assert.equal(deal.contact_id, null);
    assert.equal(deal.stage, "lead");
  });

  test("moving it records the move and touches the date", async () => {
    const deal = await dealNamed(business.id, user.id, "Monthly supply");
    await q("UPDATE opportunities SET updated_on = '2026-01-01' WHERE id = $1", [deal.id]);

    const moved = await moveOpportunity({
      id: deal.id, businessId: business.id, userId: user.id,
      stage: "negotiation", closed: false
    });

    assert.equal(moved.stage, "negotiation");
    assert.notEqual(String(moved.updated_on).slice(0, 10), "2026-01-01");
    assert.equal(moved.closed_on, null, "still open, so nothing is closed");
  });

  test("winning it stamps a closing date", async () => {
    const deal = await dealNamed(business.id, user.id, "Monthly supply");
    const won = await moveOpportunity({
      id: deal.id, businessId: business.id, userId: user.id, stage: "won", closed: true
    });
    assert.equal(won.stage, "won");
    assert.ok(won.closed_on);
  });

  test("and reopening it clears that date again, because deals come back", async () => {
    const deal = await dealNamed(business.id, user.id, "Monthly supply");
    const back = await moveOpportunity({
      id: deal.id, businessId: business.id, userId: user.id, stage: "proposal", closed: false
    });
    assert.equal(back.closed_on, null);
  });

  test("the forecast reads off what is actually there", async () => {
    const out = pipeline(await listOpportunities(business.id, user.id));
    assert.equal(out.open.count, 2);
    assert.equal(out.open.value, 53000);
    // 50000 at proposal (60%) + 3000 still at lead (10%).
    assert.equal(out.open.weighted, 30300);
  });

  test("somebody else's deal cannot be moved", async () => {
    const other = await makeUser("crm-other");
    try {
      const deal = await dealNamed(business.id, user.id, "Monthly supply");
      const out = await moveOpportunity({
        id: deal.id, businessId: business.id, userId: other.id, stage: "won", closed: true
      });
      assert.equal(out, null);
    } finally {
      await dropUser(other.id);
    }
  });

  test("deleting one removes it", async () => {
    const before = (await listOpportunities(business.id, user.id)).length;
    const deal = await dealNamed(business.id, user.id, "Walk-in enquiry");
    assert.equal(await deleteOpportunity(deal.id, business.id, user.id), true);
    assert.equal((await listOpportunities(business.id, user.id)).length, before - 1);
  });
});

describe("the support desk", { skip: skipWithoutDb }, () => {
  let user;
  let business;
  let contact;
  let raised;

  before(async () => {
    user = await makeUser("crm-support");
    business = await makeBusiness(user.id, "Desk Co");
    contact = await makeContact(business.id, user.id, "ada2@example.test");
  });
  after(async () => { await dropUser(user?.id); });

  test("raising a case takes the first message with it", async () => {
    raised = await createCase({
      businessId: business.id, userId: user.id, contactId: contact.id,
      subject: "Delivery arrived short", priority: "high",
      body: "Two crates missing from Tuesday's order."
    });

    const full = await getCase(raised.id, business.id, user.id);
    assert.equal(full.subject, "Delivery arrived short");
    assert.equal(full.messages.length, 1);
    assert.equal(full.messages[0].author, "customer");
  });

  test("and lands on the contact's timeline", async () => {
    const events = await eventsFor(contact.id);
    assert.ok(events.some((e) => e.kind === "case" && /Case raised/.test(e.detail)));
  });

  test("a case from somebody not on file records their name instead", async () => {
    const walkIn = await createCase({
      businessId: business.id, userId: user.id,
      subject: "Wrong change given", reporter: "Walk-in customer"
    });
    assert.equal(walkIn.contact_id, null);
    assert.equal(walkIn.reporter, "Walk-in customer");
  });

  test("both sides of the conversation land in one thread, in order", async () => {
    await addCaseMessage({
      caseId: raised.id, businessId: business.id, userId: user.id,
      author: "us", body: "Sorry — sending the two crates today."
    });
    await addCaseMessage({
      caseId: raised.id, businessId: business.id, userId: user.id,
      author: "customer", body: "Received, thank you."
    });

    const full = await getCase(raised.id, business.id, user.id);
    assert.deepEqual(full.messages.map((m) => m.author), ["customer", "us", "customer"]);
  });

  test("a message cannot be attached to somebody else's case", async () => {
    const other = await makeUser("crm-desk-other");
    try {
      const out = await addCaseMessage({
        caseId: raised.id, businessId: business.id, userId: other.id,
        author: "us", body: "Sneaking in"
      });
      assert.equal(out, null);
    } finally {
      await dropUser(other.id);
    }
  });

  test("resolving it stamps the time", async () => {
    const out = await setCaseStatus({
      id: raised.id, businessId: business.id, userId: user.id, status: "resolved"
    });
    assert.equal(out.status, "resolved");
    assert.ok(out.resolved_at);
  });

  test("and reopening clears it", async () => {
    const out = await setCaseStatus({
      id: raised.id, businessId: business.id, userId: user.id, status: "open"
    });
    assert.equal(out.resolved_at, null);
  });

  test("the board sorts by what needs answering first", async () => {
    const board = caseBoard(await listCases(business.id, user.id));
    assert.equal(board.counts.total, 2);
    // The high-priority one raised first outranks the normal walk-in.
    assert.equal(board.rows[0].subject, "Delivery arrived short");
  });

  test("replies are counted without loading them", async () => {
    const rows = await listCases(business.id, user.id);
    const withThread = rows.find((r) => r.id === raised.id);
    assert.equal(withThread.reply_count, 3);
  });
});

describe("who a deal or case can be attached to", { skip: skipWithoutDb }, () => {
  let user;
  let business;

  before(async () => {
    user = await makeUser("crm-contacts");
    business = await makeBusiness(user.id, "Picker Co");
    await makeContact(business.id, user.id, "one@example.test");
  });
  after(async () => { await dropUser(user?.id); });

  test("only this business's own contacts", async () => {
    const other = await makeUser("crm-contacts-other");
    try {
      const theirs = await makeBusiness(other.id, "Someone Else");
      await makeContact(theirs.id, other.id, "two@example.test");

      const pickable = await pickableContacts(business.id, user.id);
      assert.equal(pickable.length, 1);
      assert.equal(pickable[0].email, "one@example.test");
    } finally {
      await dropUser(other.id);
    }
  });
});

after(async () => { await closePool(); });
