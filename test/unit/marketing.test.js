import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  SEGMENTS,
  audienceFor,
  audiencePreview,
  deriveStage,
  funnelMetrics,
  isSegment,
  personalise,
  slugify
} from "../../utils/marketing.js";

const contact = (over = {}) => ({
  id: 1, email: "a@example.com", status: "subscribed", stage: "lead",
  consent_at: "2026-05-01T00:00:00Z", last_emailed_at: null, ...over
});

describe("audienceFor — who may be emailed", () => {
  test("includes a subscribed contact", () => {
    assert.equal(audienceFor([contact()], "all").length, 1);
  });

  test("NEVER includes someone who unsubscribed", () => {
    const list = [contact({ id: 1 }), contact({ id: 2, status: "unsubscribed" })];
    const audience = audienceFor(list, "all");
    assert.equal(audience.length, 1);
    assert.equal(audience[0].id, 1);
  });

  test("never includes a bounced address", () => {
    assert.equal(audienceFor([contact({ status: "bounced" })], "all").length, 0);
  });

  test("never includes a contact with no consent recorded", () => {
    assert.equal(audienceFor([contact({ consent_at: null })], "all").length, 0);
  });

  test("never includes a contact with no address", () => {
    assert.equal(audienceFor([contact({ email: "" })], "all").length, 0);
  });

  test("an unknown segment reaches nobody, not everybody", () => {
    // The safe direction to fail in: a typo must not become a send to the
    // entire list.
    assert.equal(audienceFor([contact(), contact({ id: 2 })], "everyone").length, 0);
    assert.equal(audienceFor([contact()], "").length, 0);
    assert.equal(audienceFor([contact()], undefined).length, 0);
    assert.equal(audienceFor([contact()], "__proto__").length, 0);
  });

  test("consent is checked before the segment, so no segment can widen it", () => {
    const unsubscribed = [
      contact({ id: 1, status: "unsubscribed", stage: "lead" }),
      contact({ id: 2, status: "unsubscribed", stage: "customer" }),
      contact({ id: 3, status: "unsubscribed", stage: "engaged" })
    ];
    for (const segment of Object.keys(SEGMENTS)) {
      assert.equal(audienceFor(unsubscribed, segment).length, 0, segment);
    }
  });

  test("segments narrow the subscribed list", () => {
    const list = [
      contact({ id: 1, stage: "lead" }),
      contact({ id: 2, stage: "customer" }),
      contact({ id: 3, stage: "engaged" }),
      contact({ id: 4, stage: "lapsed" })
    ];
    assert.equal(audienceFor(list, "all").length, 4);
    assert.equal(audienceFor(list, "leads").length, 1);
    assert.equal(audienceFor(list, "customers").length, 1);
    assert.equal(audienceFor(list, "lapsed").length, 1);
  });

  test("never_emailed means exactly that", () => {
    const list = [
      contact({ id: 1, last_emailed_at: null }),
      contact({ id: 2, last_emailed_at: "2026-05-02T00:00:00Z" })
    ];
    const audience = audienceFor(list, "never_emailed");
    assert.equal(audience.length, 1);
    assert.equal(audience[0].id, 1);
  });

  test("an empty list is an empty audience", () => {
    assert.deepEqual(audienceFor([], "all"), []);
  });
});

describe("audiencePreview — what the business is told first", () => {
  test("counts who is reachable and who is being left out, and why", () => {
    const list = [
      contact({ id: 1 }),
      contact({ id: 2, status: "unsubscribed" }),
      contact({ id: 3, status: "bounced" })
    ];
    const preview = audiencePreview(list, "all");
    assert.equal(preview.reachable, 1);
    assert.equal(preview.excludedUnsubscribed, 1);
    assert.equal(preview.excludedBounced, 1);
    assert.equal(preview.total, 3);
    assert.equal(preview.valid, true);
  });

  test("flags an unknown segment rather than guessing", () => {
    const preview = audiencePreview([contact()], "nonsense");
    assert.equal(preview.valid, false);
    assert.equal(preview.reachable, 0);
  });
});

describe("isSegment", () => {
  test("accepts the real ones and nothing else", () => {
    assert.equal(isSegment("all"), true);
    assert.equal(isSegment("customers"), true);
    assert.equal(isSegment("everyone"), false);
    // Inherited properties must not count as segments.
    assert.equal(isSegment("toString"), false);
    assert.equal(isSegment("constructor"), false);
  });
});

describe("funnelMetrics", () => {
  test("measures capture against views", () => {
    const m = funnelMetrics({
      funnel: { views: 100 },
      contacts: [contact({ id: 1 }), contact({ id: 2 })]
    });
    assert.equal(m.views, 100);
    assert.equal(m.captured, 2);
    assert.equal(m.captureRate, 2);
  });

  test("measures conversion against captures", () => {
    const m = funnelMetrics({
      funnel: { views: 10 },
      contacts: [
        contact({ id: 1, stage: "customer" }),
        contact({ id: 2, stage: "lapsed" }),
        contact({ id: 3, stage: "lead" }),
        contact({ id: 4, stage: "lead" })
      ]
    });
    assert.equal(m.customers, 2, "lapsed customers still bought once");
    assert.equal(m.conversionRate, 50);
  });

  test("counts the unsubscribed separately from the reachable", () => {
    const m = funnelMetrics({
      funnel: { views: 5 },
      contacts: [contact({ id: 1 }), contact({ id: 2, status: "unsubscribed" })]
    });
    assert.equal(m.subscribed, 1);
    assert.equal(m.unsubscribed, 1);
  });

  test("has no opinion with nothing to go on", () => {
    const m = funnelMetrics({ funnel: { views: 0 }, contacts: [] });
    assert.equal(m.captureRate, null);
    assert.equal(m.conversionRate, null);
    assert.equal(m.reachRate, null);
  });
});

describe("deriveStage", () => {
  const today = "2026-08-01";

  test("someone who has not been written to is a lead", () => {
    assert.equal(deriveStage(contact(), { hasPurchased: false, today }), "lead");
  });

  test("someone who has been emailed is engaged", () => {
    assert.equal(
      deriveStage(contact({ last_emailed_at: "2026-07-01T00:00:00Z" }), { hasPurchased: false, today }),
      "engaged"
    );
  });

  test("someone who bought is a customer", () => {
    assert.equal(
      deriveStage(contact(), { hasPurchased: true, lastPurchaseOn: "2026-07-20", today }),
      "customer"
    );
  });

  test("a customer who went quiet has lapsed", () => {
    assert.equal(
      deriveStage(contact(), { hasPurchased: true, lastPurchaseOn: "2026-01-01", today }),
      "lapsed"
    );
  });

  test("buying outranks being emailed", () => {
    assert.equal(
      deriveStage(contact({ last_emailed_at: "2026-07-01T00:00:00Z" }),
        { hasPurchased: true, lastPurchaseOn: "2026-07-25", today }),
      "customer"
    );
  });
});

describe("slugify", () => {
  test("makes a URL-safe stem", () => {
    assert.equal(slugify("Sugar 2kg Offer!"), "sugar-2kg-offer");
  });

  test("collapses punctuation and spacing", () => {
    assert.equal(slugify("  Mama   Njeri's  —  Big   Deal  "), "mama-njeris-big-deal");
  });

  test("appends a suffix for uniqueness", () => {
    assert.equal(slugify("Rice", "a1b2c"), "rice-a1b2c");
  });

  test("never produces an empty slug", () => {
    assert.equal(slugify(""), "offer");
    assert.equal(slugify("!!!"), "offer");
    assert.equal(slugify(null), "offer");
  });

  test("keeps slugs a sane length", () => {
    assert.ok(slugify("x".repeat(200)).length <= 48);
  });
});

describe("personalise", () => {
  test("uses the first name when there is one", () => {
    assert.equal(
      personalise("Hi {{first_name}},", contact({ name: "Wanjiru Kamau" })),
      "Hi Wanjiru,"
    );
  });

  test("falls back to something that still reads", () => {
    assert.equal(personalise("Hi {{first_name}},", contact({ name: null })), "Hi there,");
  });

  test("replaces every occurrence", () => {
    assert.equal(
      personalise("{{first_name}} {{first_name}}", contact({ name: "Ada" })),
      "Ada Ada"
    );
  });

  test("leaves text with no placeholders alone", () => {
    assert.equal(personalise("Plain text", contact()), "Plain text");
  });
});
