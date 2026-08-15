import { config } from "../config/env.js";
import {
  findAccountByMonoId,
  upsertMonoAccount
} from "../db/queries/accounts.js";
import {
  getAccountDetails,
  initiateLink,
  syncMonoAccount,
  userIdFromRef
} from "../services/mono.js";

function appUrl() {
  return config.appUrl || `http://localhost:${config.port}`;
}

export async function startConnect(req, res, next) {
  if (!config.mono.secretKey) {
    req.flash("error", "Bank linking isn't configured on this server yet.");
    return res.redirect("/accounts");
  }

  try {
    const { monoUrl } = await initiateLink({
      userId: req.session.user.id,
      name: req.session.user.name,
      email: req.session.user.email,
      redirectUrl: `${appUrl()}/accounts/mono/redirect`
    });
    return res.redirect(monoUrl);
  } catch (error) {
    return next(error);
  }
}

export function finishConnect(req, res) {
  req.flash(
    "warn",
    "Almost done — your bank link is finishing in the background. " +
      "Give it a few seconds, then refresh this page."
  );
  return res.redirect("/accounts");
}

// Mono, not a browser: authenticated by the mono-webhook-secret header, not
// a session or requireSameOrigin. Unknown events and payloads we can't
// attribute are acknowledged and ignored rather than treated as errors —
// this endpoint has no way to tell "an event we don't handle yet" apart from
// "Mono changed their payload shape", and neither should ever make Mono
// retry-storm us.
export async function handleWebhook(req, res) {
  const signature = req.headers["mono-webhook-secret"];
  if (!config.mono.webhookSecret || signature !== config.mono.webhookSecret) {
    return res.status(401).end();
  }

  const { event, data } = req.body || {};

  try {
    if (event === "mono.events.account_connected") {
      const ref = data?.meta?.ref;
      const monoAccountId = data?.id;
      const userId = userIdFromRef(ref);
      if (userId && monoAccountId) {
        let details = {};
        try {
          details = await getAccountDetails(monoAccountId);
        } catch {
          // Best-effort — the account still links without a friendly name.
        }
        await upsertMonoAccount({
          userId,
          ref,
          monoAccountId,
          institutionName: details.institutionName,
          accountNumberMask: details.accountNumberMask
        });
      }
    } else if (event === "mono.events.account_updated") {
      if (data?.data_status === "AVAILABLE") {
        const account = await findAccountByMonoId(data?.id);
        if (account) {
          await syncMonoAccount(account);
        }
      }
    }
  } catch (error) {
    console.error(`Mono webhook (${event}) failed: ${error.message}`);
  }

  return res.status(200).end();
}
