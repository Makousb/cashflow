import { config } from "../config/env.js";

// Outgoing mail.
//
// Nothing is sent unless SMTP is configured, and a send that fails is reported
// back rather than thrown. Callers here are background jobs — a mail server
// having a bad afternoon must never cost a business its monthly close.
//
// nodemailer is imported lazily so an install that never sends mail does not
// pay for loading it, and so a missing module degrades to "not configured"
// instead of taking the app down at boot.

let transport;

export function mailEnabled() {
  return Boolean(config.mail.host);
}

async function getTransport() {
  if (transport) return transport;
  const { default: nodemailer } = await import("nodemailer");
  transport = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user
      ? { user: config.mail.user, pass: config.mail.password }
      : undefined
  });
  return transport;
}

// Returns { sent, reason } and never throws.
export async function sendMail({ to, subject, text, html }) {
  if (!mailEnabled()) return { sent: false, reason: "no SMTP host configured" };
  if (!to) return { sent: false, reason: "no recipient" };

  try {
    const mailer = await getTransport();
    await mailer.sendMail({ from: config.mail.from, to, subject, text, html });
    return { sent: true };
  } catch (error) {
    console.warn(`Mail: could not send to ${to} (${error.message})`);
    return { sent: false, reason: error.message };
  }
}

// Exposed for tests, which swap in their own transport rather than talking to
// a real mail server.
export function __setTransport(stub) {
  transport = stub;
}
