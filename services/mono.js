import crypto from "crypto";

import { config } from "../config/env.js";
import { toISODate } from "../utils/dates.js";
import { importMonoTransaction } from "../db/queries/transactions.js";
import { listMonoLinkedAccounts, touchMonoSync } from "../db/queries/accounts.js";

const API_BASE = "https://api.withmono.com";
const TIMEOUT_MS = 10000;

// A user id is folded straight into the ref so the webhook — which only ever
// hands back whatever ref we gave it — can be matched to a Cashflow user
// with no separate "pending link" table to create, expire, or clean up.
// Ref is opaque to Mono and simply round-trips.
export function makeLinkRef(userId) {
  return `u${userId}-${crypto.randomBytes(6).toString("hex")}`;
}

export function userIdFromRef(ref) {
  const match = /^u(\d+)-/.exec(ref || "");
  return match ? Number(match[1]) : null;
}

async function request(path, { method = "GET", body, query } = {}) {
  if (!config.mono.secretKey) {
    throw new Error("Mono is not configured (MONO_SECRET_KEY is unset).");
  }

  const url = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, value);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        "mono-sec-key": config.mono.secretKey,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const message = json?.message || `HTTP ${res.status}`;
      throw new Error(`Mono ${method} ${path} failed: ${message}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// Starts a Connect Link session and returns the hosted page to send the
// user's browser to. Their bank credentials are entered there, on Mono's own
// page — this call and everything else in this file never sees them.
export async function initiateLink({ userId, name, email, redirectUrl }) {
  const ref = makeLinkRef(userId);
  const json = await request("/v2/accounts/initiate", {
    method: "POST",
    body: {
      customer: { name, email },
      scope: "auth",
      redirect_url: redirectUrl,
      meta: { ref }
    }
  });

  const monoUrl = json?.data?.mono_url;
  if (!monoUrl) {
    throw new Error("Mono did not return a linking URL.");
  }
  return { monoUrl, ref };
}

export async function getAccountDetails(monoAccountId) {
  const json = await request(`/v2/accounts/${monoAccountId}`);
  const account = json?.data?.account;
  const institution = account?.institution;
  return {
    institutionName: institution?.name || null,
    accountNumberMask: account?.accountNumber
      ? `••••${String(account.accountNumber).slice(-4)}`
      : null
  };
}

// Mono returns amounts in minor units (cents for KES) and a debit/credit
// type; this maps each row straight to what createTransaction/
// importMonoTransaction expect — major units and this app's own
// expense/income vocabulary.
function normalizeTransaction(raw) {
  return {
    sourceId: String(raw.id ?? raw._id),
    kind: raw.type === "credit" ? "income" : "expense",
    amount: Number(raw.amount) / 100,
    note: raw.narration || null,
    occurredOn: toISODate(raw.date)
  };
}

export async function listTransactions(monoAccountId, { start, end } = {}) {
  const json = await request(`/v2/accounts/${monoAccountId}/transactions`, {
    query: { paginate: "false", start, end }
  });
  const raw = json?.data?.data || json?.data || [];
  return raw.map(normalizeTransaction);
}

// Pull whatever's new for one linked account and file it, same shape as
// materializeDueRecurring: idempotent (importMonoTransaction dedupes on
// source_id) and safe to call from more than one place — the webhook when
// Mono lets us know data is ready, and best-effort on page load so a sync
// isn't only as reliable as this app's Render free-tier dyno being awake
// when that webhook happens to arrive.
export async function syncMonoAccount(account) {
  // First sync has no watermark to work from; 90 days is enough to seed a
  // dashboard without asking Mono for a whole account history up front.
  const start = account.mono_synced_at
    ? toISODate(account.mono_synced_at)
    : toISODate(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));

  const transactions = await listTransactions(account.mono_account_id, { start });

  let imported = 0;
  for (const tx of transactions) {
    const row = await importMonoTransaction({
      userId: account.user_id,
      accountId: account.id,
      sourceId: tx.sourceId,
      kind: tx.kind,
      amount: tx.amount,
      note: tx.note,
      occurredOn: tx.occurredOn
    });
    if (row) imported += 1;
  }

  await touchMonoSync(account.id);
  return imported;
}

// One user's whole set of linked accounts, each failing on its own so one
// account Mono is having trouble with doesn't take the others — or the page
// that triggered this — down with it.
export async function syncAllMonoAccounts(userId) {
  const accounts = await listMonoLinkedAccounts(userId);
  for (const account of accounts) {
    try {
      await syncMonoAccount(account);
    } catch (error) {
      console.warn(`Mono sync failed for account ${account.id}: ${error.message}`);
    }
  }
}
