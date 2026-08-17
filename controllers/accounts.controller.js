import { config } from "../config/env.js";
import { createAccount, listAccounts } from "../db/queries/accounts.js";
import { syncAllMonoAccounts } from "../services/mono.js";
import { today } from "../utils/dates.js";

const ACCOUNT_TYPES = ["cash", "bank", "mobile_money", "credit_card"];

export async function listAccountsPage(req, res, next) {
  try {
    // Best-effort and never awaited: same lazy-catch-up-on-page-load shape as
    // refreshRates() in app.js. A linked account is current as of whenever
    // this page was last opened rather than on a schedule this app has no
    // cron to run — the balance/transactions shown just now may be a sync
    // behind, and will catch up the next time this page loads.
    syncAllMonoAccounts(req.session.user.id).catch(() => {});

    const accounts = await listAccounts(req.session.user.id);
    res.render("accounts", {
      title: "Accounts",
      accounts,
      accountTypes: ACCOUNT_TYPES,
      monoEnabled: Boolean(config.mono.secretKey),
      today: today()
    });
  } catch (error) {
    next(error);
  }
}

export async function addAccount(req, res, next) {
  const name = (req.body.name || "").trim();
  const type = ACCOUNT_TYPES.includes(req.body.type) ? req.body.type : "cash";

  if (!name) {
    req.flash("error", "Give the account a name.");
    return res.redirect("/accounts");
  }

  try {
    await createAccount({ userId: req.session.user.id, name, type });
    req.flash("success", "Account added.");
    return res.redirect("/accounts");
  } catch (error) {
    return next(error);
  }
}
