import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  captureContact,
  claimCampaignForSending,
  createCampaign,
  createFunnel,
  getLiveFunnelBySlug,
  listContacts,
  markBounced,
  markEmailed,
  reachableContacts,
  recordEvent,
  setFunnelStatus,
  unsubscribeByToken
} from "../../db/queries/marketing.js";
import { audienceFor } from "../../utils/marketing.js";
import {
  closePool,
  dropUser,
  makeBusiness,
  makeUser,
  one,
  q,
  skipWithoutDb
} from "./helpers.js";

const funnelFor = (businessId, userId, over = {}) =>
  createFunnel({
    businessId, userId,
    name: over.name || "Test Funnel",
    slug: over.slug || `test-${Math.random().toString(36).slice(2, 9)}`,
    headline: "A headline", subhead: "A subhead", offer: "An offer",
    cta: "Sign up", incentive: "Early notice", mode: "offline"
  });

describe("capturing an address", { skip: skipWithoutDb }, () => {
  let user;
  let shop;
  let funnel;

  before(async () => {
    user = await makeUser("capture");
    shop = await makeBusiness(user.id, "Capture Co");
    funnel = await funnelFor(shop.id, user.id);
  });

  after(async () => { await dropUser(user?.id); });

  test("records consent, a source and a token", async () => {
    const contact = await captureContact({
      businessId: shop.id, userId: user.id, funnelId: funnel.id,
      email: "first@example.com", name: "First Person",
      source: `funnel:${funnel.slug}`, consentSource: "funnel form"
    });
    assert.equal(contact.status, "subscribed");
    assert.ok(contact.consent_at, "consent must be timestamped");
    assert.equal(contact.consent_source, "funnel form");
    assert.ok(contact.unsubscribe_token, "a token is needed to ever leave");
    assert.equal(contact.is_new, true);
  });

  test("signing up twice is one contact, not two", async () => {
    const again = await captureContact({
      businessId: shop.id, userId: user.id, funnelId: funnel.id,
      email: "FIRST@example.com", name: "First Person",
      source: "second time", consentSource: "funnel form"
    });
    assert.equal(again.is_new, false, "matched case-insensitively");
    assert.equal((await listContacts(shop.id, user.id)).length, 1);
  });

  test("the same address at a different business is a different contact", async () => {
    const other = await makeBusiness(user.id, "Other Co");
    const otherFunnel = await funnelFor(other.id, user.id);
    const contact = await captureContact({
      businessId: other.id, userId: user.id, funnelId: otherFunnel.id,
      email: "first@example.com", name: "First Person",
      source: "other", consentSource: "funnel form"
    });
    assert.equal(contact.is_new, true);
    assert.notEqual(contact.business_id, shop.id);
  });

  test("tokens are unique per contact", async () => {
    await captureContact({
      businessId: shop.id, userId: user.id, funnelId: funnel.id,
      email: "second@example.com", name: null, source: "s", consentSource: "funnel form"
    });
    const rows = await q(
      "SELECT unsubscribe_token FROM contacts WHERE business_id = $1", [shop.id]
    );
    assert.equal(new Set(rows.map((r) => r.unsubscribe_token)).size, rows.length);
  });
});

describe("leaving", { skip: skipWithoutDb }, () => {
  let user;
  let shop;
  let funnel;
  let contact;

  before(async () => {
    user = await makeUser("unsub");
    shop = await makeBusiness(user.id, "Unsub Co");
    funnel = await funnelFor(shop.id, user.id);
    contact = await captureContact({
      businessId: shop.id, userId: user.id, funnelId: funnel.id,
      email: "leaver@example.com", name: "Leaver", source: "f", consentSource: "funnel form"
    });
  });

  after(async () => { await dropUser(user?.id); });

  test("one click, no login", async () => {
    const left = await unsubscribeByToken(contact.unsubscribe_token);
    assert.equal(left.status, "unsubscribed");
    assert.ok(left.unsubscribed_at);
  });

  test("clicking an old link again still reports success", async () => {
    // A second click on a stale email must not look like a failure to leave.
    const again = await unsubscribeByToken(contact.unsubscribe_token);
    assert.ok(again);
    assert.equal(again.status, "unsubscribed");
  });

  test("an unknown token changes nothing", async () => {
    assert.equal(await unsubscribeByToken("not-a-real-token"), null);
  });

  test("they are gone from the reachable list immediately", async () => {
    const reachable = await reachableContacts(shop.id, user.id);
    assert.equal(reachable.some((c) => c.id === contact.id), false);
  });

  test("signing up again does NOT put them back on the list", async () => {
    // Re-entering an address must not undo an unsubscribe, or the unsubscribe
    // means nothing.
    const resubmitted = await captureContact({
      businessId: shop.id, userId: user.id, funnelId: funnel.id,
      email: "leaver@example.com", name: "Leaver", source: "f", consentSource: "funnel form"
    });
    assert.equal(resubmitted.status, "unsubscribed", "still unsubscribed");
    const reachable = await reachableContacts(shop.id, user.id);
    assert.equal(reachable.some((c) => c.id === contact.id), false);
  });
});

describe("who a campaign can reach", { skip: skipWithoutDb }, () => {
  let user;
  let shop;
  let funnel;

  before(async () => {
    user = await makeUser("reach");
    shop = await makeBusiness(user.id, "Reach Co");
    funnel = await funnelFor(shop.id, user.id);

    for (const [email, status] of [
      ["ok1@example.com", "subscribed"],
      ["ok2@example.com", "subscribed"],
      ["gone@example.com", "unsubscribed"],
      ["bounced@example.com", "bounced"]
    ]) {
      const c = await captureContact({
        businessId: shop.id, userId: user.id, funnelId: funnel.id,
        email, name: null, source: "f", consentSource: "funnel form"
      });
      if (status !== "subscribed") {
        await q("UPDATE contacts SET status = $2 WHERE id = $1", [c.id, status]);
      }
    }
  });

  after(async () => { await dropUser(user?.id); });

  test("the query itself refuses to return anyone who left", async () => {
    // Belt and braces: even if a caller forgot to filter, this cannot hand
    // back an unsubscribed row.
    const reachable = await reachableContacts(shop.id, user.id);
    assert.equal(reachable.length, 2);
    assert.ok(reachable.every((c) => c.status === "subscribed"));
  });

  test("and the engine filters them again", async () => {
    const all = await listContacts(shop.id, user.id);
    assert.equal(all.length, 4, "all four exist");
    assert.equal(audienceFor(all, "all").length, 2, "only two are reachable");
  });

  test("a bounce takes an address out of every future send", async () => {
    const [fresh] = await q(
      "SELECT * FROM contacts WHERE business_id = $1 AND email = 'ok1@example.com'", [shop.id]
    );
    await markBounced(fresh.id);
    const reachable = await reachableContacts(shop.id, user.id);
    assert.equal(reachable.some((c) => c.id === fresh.id), false);
  });

  test("marking emailed does not change who is reachable", async () => {
    const before = await reachableContacts(shop.id, user.id);
    await markEmailed(before.map((c) => c.id));
    const after = await reachableContacts(shop.id, user.id);
    assert.equal(after.length, before.length);
    assert.ok(after.every((c) => c.last_emailed_at));
  });

  test("another user's contacts are not visible", async () => {
    const other = await makeUser("reach-other");
    assert.equal((await reachableContacts(shop.id, other.id)).length, 0);
    await dropUser(other.id);
  });
});

describe("sending a campaign", { skip: skipWithoutDb }, () => {
  let user;
  let shop;

  before(async () => {
    user = await makeUser("campaign");
    shop = await makeBusiness(user.id, "Campaign Co");
  });

  after(async () => { await dropUser(user?.id); });

  const draft = () =>
    createCampaign({
      businessId: shop.id, userId: user.id, name: "Promo",
      subject: "Hello", body: "Hi {{first_name}}", segment: "all", mode: "offline"
    });

  test("a draft can be claimed once", async () => {
    const campaign = await draft();
    assert.equal(campaign.status, "draft");
    const claimed = await claimCampaignForSending(campaign.id, user.id);
    assert.ok(claimed);
    assert.equal(claimed.status, "sent");
  });

  test("and never twice — no double send", async () => {
    const campaign = await draft();
    const results = await Promise.all([
      claimCampaignForSending(campaign.id, user.id),
      claimCampaignForSending(campaign.id, user.id),
      claimCampaignForSending(campaign.id, user.id)
    ]);
    assert.equal(results.filter(Boolean).length, 1);
  });

  test("another user cannot send it", async () => {
    const campaign = await draft();
    const other = await makeUser("campaign-other");
    assert.equal(await claimCampaignForSending(campaign.id, other.id), null);
    const [still] = await q("SELECT status FROM campaigns WHERE id = $1", [campaign.id]);
    assert.equal(still.status, "draft");
    await dropUser(other.id);
  });
});

describe("the public funnel page", { skip: skipWithoutDb }, () => {
  let user;
  let shop;
  let funnel;

  before(async () => {
    user = await makeUser("public");
    shop = await makeBusiness(user.id, "Public Co");
    funnel = await funnelFor(shop.id, user.id, { slug: `pub-${Date.now()}` });
  });

  after(async () => { await dropUser(user?.id); });

  test("a draft funnel is not reachable by strangers", async () => {
    assert.equal(await getLiveFunnelBySlug(funnel.slug), null);
  });

  test("a live one is", async () => {
    await setFunnelStatus(funnel.id, user.id, "live");
    const live = await getLiveFunnelBySlug(funnel.slug);
    assert.ok(live);
    assert.equal(live.business_name, "Public Co");
  });

  test("pausing takes it down again", async () => {
    await setFunnelStatus(funnel.id, user.id, "paused");
    assert.equal(await getLiveFunnelBySlug(funnel.slug), null);
  });

  test("another user cannot change its status", async () => {
    const other = await makeUser("public-other");
    assert.equal(await setFunnelStatus(funnel.id, other.id, "live"), null);
    await dropUser(other.id);
  });
});

describe("the relationship timeline", { skip: skipWithoutDb }, () => {
  let user;
  let shop;
  let contact;

  before(async () => {
    user = await makeUser("timeline");
    shop = await makeBusiness(user.id, "Timeline Co");
    const funnel = await funnelFor(shop.id, user.id);
    contact = await captureContact({
      businessId: shop.id, userId: user.id, funnelId: funnel.id,
      email: "history@example.com", name: "History", source: "f", consentSource: "funnel form"
    });
  });

  after(async () => { await dropUser(user?.id); });

  test("records what happened to a contact", async () => {
    await recordEvent({ contactId: contact.id, kind: "captured", detail: "Signed up" });
    await recordEvent({ contactId: contact.id, kind: "emailed", detail: "Sent a promo" });
    const events = await q(
      "SELECT kind FROM contact_events WHERE contact_id = $1 ORDER BY id", [contact.id]
    );
    assert.deepEqual(events.map((e) => e.kind), ["captured", "emailed"]);
  });

  test("history goes when the contact goes", async () => {
    await q("DELETE FROM contacts WHERE id = $1", [contact.id]);
    const events = await q(
      "SELECT id FROM contact_events WHERE contact_id = $1", [contact.id]
    );
    assert.equal(events.length, 0);
  });
});

// One teardown for the whole file — every suite in it shares the same pool.
after(async () => {
  await closePool();
});
