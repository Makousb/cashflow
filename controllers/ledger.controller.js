import {
  backfillJournals,
  createAccount,
  ensureChart,
  getEntry,
  ledgerLines,
  listAccounts,
  listCloses,
  listEntries,
  postEntryAlone,
  reopenPeriod,
  closePeriod,
  unpostedCount
} from "../db/queries/ledger.js";
import { getBusiness } from "../db/queries/business.js";
import { backfillProvisions } from "../db/queries/tax.js";
import { toBase } from "../services/fx.js";
import { ACCOUNT_TYPES, checkEntry, fiscalYear, trialBalance } from "../utils/ledger.js";
import { today } from "../utils/dates.js";

async function requireBusiness(req, res) {
  const business = await getBusiness(Number(req.params.id), req.session.user.id);
  if (!business) {
    req.flash("error", "Business not found.");
    res.redirect("/business");
    return null;
  }
  return business;
}

// The trial balance is the ledger's own audit: every debit ever posted against
// every credit ever posted. It is not a report anybody asks for so much as the
// proof that the reports are worth reading, which is why it leads the page.
export async function showLedger(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const userId = req.session.user.id;
    // A business created before the ledger, or one whose chart was somehow
    // never opened, gets it here rather than erroring on an empty page.
    await ensureChart(business.id, userId);

    const [accounts, lines, entries, unposted, closes] = await Promise.all([
      listAccounts(business.id, userId),
      ledgerLines(business.id, userId),
      listEntries(business.id, userId, 50),
      unpostedCount(business.id, userId),
      listCloses(business.id, userId)
    ]);

    const trial = trialBalance(accounts, lines);

    // The year on offer is the one after whatever was closed last — or the one
    // the earliest entry falls in, for books that have never been closed.
    const lastClosed = closes[0] || null;
    const nextYear = fiscalYear(
      business.fiscal_year_end_month,
      lastClosed
        // A day past the last close lands in the following year.
        ? new Date(Date.parse(`${lastClosed.period_end}T00:00:00`) + 86400000)
        : (entries.at(-1)?.entry_date || today())
    );

    return res.render("ledger", {
      title: `${business.name} · General ledger`,
      business,
      accounts,
      trial,
      entries,
      unposted,
      closes,
      nextYear,
      closedThrough: business.books_closed_through
        ? String(business.books_closed_through).slice(0, 10)
        : null,
      accountTypes: ACCOUNT_TYPES,
      today: today()
    });
  } catch (error) {
    return next(error);
  }
}

export async function showEntry(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const entry = await getEntry(Number(req.params.entryId), business.id, req.session.user.id);
    if (!entry) {
      req.flash("error", "That entry is not in this ledger.");
      return res.redirect(`/business/${business.id}/ledger`);
    }

    return res.render("ledger-entry", {
      title: `${business.name} · Entry #${entry.entry_no}`,
      business,
      entry
    });
  } catch (error) {
    return next(error);
  }
}

// A journal entry made by hand — an opening balance, a correction, the stock
// adjustment at a period end. The same balance rule applies as to everything
// the modules post: refused here, refused in postEntry, refused by the schema.
export async function addEntry(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/ledger`;
  const userId = req.session.user.id;

  try {
    const accounts = await listAccounts(business.id, userId);
    const byId = new Map(accounts.map((a) => [String(a.id), a]));

    // The form posts parallel arrays. Anything without an account or an amount
    // is a blank row the person did not fill in, not an error.
    const ids = [].concat(req.body.accountId || []);
    const debits = [].concat(req.body.debit || []);
    const credits = [].concat(req.body.credit || []);

    const lines = [];
    for (let i = 0; i < ids.length; i++) {
      const account = byId.get(String(ids[i]));
      const debit = Number.parseFloat(debits[i]) || 0;
      const credit = Number.parseFloat(credits[i]) || 0;
      if (!account || (debit <= 0 && credit <= 0)) continue;

      lines.push({
        // Typed in the display currency like every other amount in the app.
        account: account.key || `#${account.id}`,
        accountId: account.id,
        debit: debit > 0 ? toBase(req.session.user, debit) : 0,
        credit: credit > 0 ? toBase(req.session.user, credit) : 0
      });
    }

    const verdict = checkEntry(lines);
    if (!verdict.ok) {
      req.flash("error", verdict.reason);
      return res.redirect(back);
    }

    // An account the owner added has no key, so it cannot be named the way the
    // built-in ones are. postEntry resolves keys, so this maps back to keys
    // where there is one and refuses the entry where there is not — better than
    // silently posting to the wrong account.
    const unkeyed = lines.find((l) => l.account.startsWith("#"));
    if (unkeyed) {
      const account = byId.get(String(unkeyed.accountId));
      req.flash(
        "error",
        `"${account.name}" is an account you added, and hand-posting to those is ` +
        "not wired up yet — use one of the built-in accounts."
      );
      return res.redirect(back);
    }

    await postEntryAlone({
      businessId: business.id,
      userId,
      lines,
      memo: (req.body.memo || "").trim().slice(0, 200) || "Manual journal entry",
      entryDate: req.body.entryDate || today(),
      source: "manual"
    });

    req.flash("success", `Entry posted — ${verdict.debits.toFixed(2)} on each side.`);
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

export async function addAccount(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/ledger`;
  const code = (req.body.code || "").trim().slice(0, 20);
  const name = (req.body.name || "").trim().slice(0, 120);
  const type = req.body.type;

  if (!code || !name || !Object.hasOwn(ACCOUNT_TYPES, type)) {
    req.flash("error", "An account needs a code, a name and a type.");
    return res.redirect(back);
  }

  try {
    const created = await createAccount({
      businessId: business.id,
      userId: req.session.user.id,
      code,
      name,
      type
    });

    req.flash(
      "success",
      created
        ? `Account ${code} ${name} added.`
        : `There is already an account numbered ${code}.`
    );
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

// Give the books that predate the ledger their journals. Deliberately a button
// rather than something that happens on page load: it writes one entry per
// historic transaction, and that should be a thing somebody chose to do.
export async function runBackfill(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    const { posted, considered } = await backfillJournals(business.id, req.session.user.id);
    // Provisions are not business_transactions, so they need their own sweep —
    // the same button should leave nothing behind whichever kind it was.
    const provisions = await backfillProvisions(business.id, req.session.user.id);
    req.flash(
      "success",
      posted + provisions.posted > 0
        ? `Posted ${posted + provisions.posted} historic entr` +
          `${posted + provisions.posted === 1 ? "y" : "ies"} to the ledger` +
          `${provisions.posted > 0 ? `, including ${provisions.posted} tax provision(s)` : ""}.`
        : considered + provisions.considered === 0
          ? "Nothing to catch up — every entry in the books is already posted."
          : "Nothing was posted; those entries already have journals."
    );
    return res.redirect(`/business/${business.id}/ledger`);
  } catch (error) {
    return next(error);
  }
}

// Close a financial year: every income and expense account is emptied into
// retained earnings, and the books are sealed to that date.
export async function closeYear(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/ledger`;

  try {
    const year = fiscalYear(business.fiscal_year_end_month, req.body.periodEnd || today());
    const out = await closePeriod({
      businessId: business.id,
      userId: req.session.user.id,
      periodStart: year.start,
      periodEnd: year.end,
      label: year.label
    });

    if (!out.ok) {
      req.flash(
        "error",
        out.reason === "already-closed"
          ? `${year.label} is already closed.`
          : `There is nothing in ${year.label} to close — no income and no expenses.`
      );
      return res.redirect(back);
    }

    req.flash(
      "success",
      `${year.label} closed. ${out.close.net >= 0 ? "A profit" : "A loss"} of ` +
      `${Math.abs(out.close.net).toFixed(2)} went to retained earnings, and the books ` +
      `are sealed to ${year.end}.`
    );
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

// And the way back out, for a year closed too early.
export async function reopenYear(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/ledger`;

  try {
    const out = await reopenPeriod({
      businessId: business.id,
      userId: req.session.user.id,
      closeId: Number(req.params.closeId)
    });

    if (!out.ok) {
      req.flash(
        "error",
        out.reason === "not-latest"
          ? "Only the most recently closed year can be reopened — reopen the later ones first."
          : "That close is not here."
      );
      return res.redirect(back);
    }

    req.flash(
      "success",
      `${out.close.label} reopened. The closing entry has been reversed rather than ` +
      "deleted, so both it and the reversal stay in the journal."
    );
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}
