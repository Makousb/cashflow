import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { promoEmail, unsubscribeUrl } from "../../utils/promo-email.js";

const business = { name: "Mama Njeri Grocers", id: 1 };
const campaign = {
  subject: "Sugar is in stock",
  body: "Hi {{first_name}},\n\nWe have sugar in at KSh 260.\n\n— Mama Njeri"
};
const contact = (over = {}) => ({
  id: 7, email: "wanjiru@example.com", name: "Wanjiru Kamau",
  unsubscribe_token: "tok_abc123", ...over
});
const build = (over = {}) =>
  promoEmail({
    business, campaign, contact: over.contact || contact(),
    baseUrl: over.baseUrl ?? "https://cashflow.example"
  });

describe("every promotion can be left", () => {
  test("the plain text carries an unsubscribe link", () => {
    assert.match(build().text, /https:\/\/cashflow\.example\/unsubscribe\/tok_abc123/);
  });

  test("so does the HTML", () => {
    assert.match(build().html, /href="https:\/\/cashflow\.example\/unsubscribe\/tok_abc123"/);
    assert.match(build().html, /Unsubscribe/);
  });

  test("both say why the person is receiving it", () => {
    assert.match(build().text, /because you gave Mama Njeri Grocers your email address/);
    assert.match(build().html, /because you gave Mama Njeri Grocers your email address/);
  });

  test("a contact with no token cannot be emailed at all", () => {
    // Refusing outright beats sending something nobody can leave.
    assert.throws(
      () => build({ contact: contact({ unsubscribe_token: null }) }),
      /unsubscribe token/
    );
  });

  test("the link is built from the token, not the address", () => {
    assert.equal(
      unsubscribeUrl("https://x.test/", contact({ unsubscribe_token: "zzz" })),
      "https://x.test/unsubscribe/zzz"
    );
  });
});

describe("the message itself", () => {
  test("is personalised in both bodies", () => {
    assert.match(build().text, /Hi Wanjiru,/);
    assert.match(build().html, /Hi Wanjiru,/);
  });

  test("falls back gracefully with no name", () => {
    assert.match(build({ contact: contact({ name: null }) }).text, /Hi there,/);
  });

  test("keeps paragraphs in the HTML", () => {
    assert.equal((build().html.match(/<p style="margin:0 0 14px/g) || []).length, 3);
  });

  test("carries the business name", () => {
    assert.match(build().html, /Mama Njeri Grocers/);
  });
});

describe("the HTML body is escaped", () => {
  // Campaign copy can come from a model, and a contact's name comes from a
  // stranger typing into a public form. Neither is trusted markup.
  test("a name with markup cannot break out", () => {
    const { html } = promoEmail({
      business, campaign,
      contact: contact({ name: '<script>alert(1)</script>' }),
      baseUrl: "https://x.test"
    });
    assert.ok(!html.includes("<script>"), "raw script tag must not survive");
    assert.match(html, /&lt;script&gt;/);
  });

  test("a body with markup is escaped", () => {
    const { html } = promoEmail({
      business,
      campaign: { subject: "s", body: '</p><img src=x onerror="alert(1)">' },
      contact: contact(), baseUrl: "https://x.test"
    });
    assert.ok(!html.includes("<img src=x"));
    assert.match(html, /&lt;img src=x/);
  });

  test("a business name with markup is escaped", () => {
    const { html } = promoEmail({
      business: { name: '<b>Loud</b>', id: 1 }, campaign,
      contact: contact(), baseUrl: "https://x.test"
    });
    assert.ok(!html.includes("<b>Loud</b>"));
  });

  test("the plain text body is left as text", () => {
    const { text } = promoEmail({
      business: { name: "Ben & Jerry's", id: 1 }, campaign,
      contact: contact(), baseUrl: "https://x.test"
    });
    assert.match(text, /Ben & Jerry's/);
  });
});
