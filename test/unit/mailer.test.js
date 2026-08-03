// The mailer is configured from the environment, which is read when the module
// first loads — hence the assignment before the dynamic import. No real SMTP
// server is involved: the transport is stubbed, so these tests never send mail.
process.env.SMTP_HOST = "smtp.invalid";
process.env.SMTP_PORT = "587";
process.env.SMTP_USER = "test";
process.env.SMTP_PASSWORD = "test";
process.env.MAIL_FROM = "Cashflow <no-reply@test.invalid>";

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

const { __setTransport, mailEnabled, sendMail } = await import("../../services/mailer.js");

const sent = [];
function transportThat(behaviour) {
  __setTransport({
    sendMail: async (message) => {
      sent.push(message);
      return behaviour ? behaviour(message) : { messageId: "stub" };
    }
  });
}

afterEach(() => { sent.length = 0; });

describe("mailEnabled", () => {
  test("is on once a host is configured", () => {
    assert.equal(mailEnabled(), true);
  });
});

describe("sendMail", () => {
  test("sends and reports success", async () => {
    transportThat();
    const result = await sendMail({
      to: "owner@example.com", subject: "S", text: "T", html: "<p>T</p>"
    });
    assert.deepEqual(result, { sent: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "owner@example.com");
    assert.equal(sent[0].from, "Cashflow <no-reply@test.invalid>");
    assert.equal(sent[0].subject, "S");
  });

  test("carries both a text and an HTML body", async () => {
    transportThat();
    await sendMail({ to: "a@b.com", subject: "S", text: "plain", html: "<p>rich</p>" });
    assert.equal(sent[0].text, "plain");
    assert.equal(sent[0].html, "<p>rich</p>");
  });

  test("refuses to send with no recipient", async () => {
    transportThat();
    const result = await sendMail({ to: "", subject: "S", text: "T" });
    assert.equal(result.sent, false);
    assert.match(result.reason, /no recipient/);
    assert.equal(sent.length, 0, "the transport is never even reached");
  });

  test("a provider failure is reported, not thrown", async () => {
    // The caller is a background job. An exception here would abandon the
    // monthly close halfway through.
    transportThat(() => { throw new Error("mailbox unavailable"); });
    const result = await sendMail({ to: "a@b.com", subject: "S", text: "T" });
    assert.equal(result.sent, false);
    assert.match(result.reason, /mailbox unavailable/);
  });

  test("a timeout is reported the same way", async () => {
    transportThat(() => Promise.reject(new Error("ETIMEDOUT")));
    const result = await sendMail({ to: "a@b.com", subject: "S", text: "T" });
    assert.equal(result.sent, false);
    assert.match(result.reason, /ETIMEDOUT/);
  });
});
