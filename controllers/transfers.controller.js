import { createTransfer, deleteTransfer } from "../db/queries/transfers.js";
import { toBase } from "../services/fx.js";
import { today } from "../utils/dates.js";

export async function addTransfer(req, res, next) {
  const amount = Number.parseFloat(req.body.amount);

  if (!Number.isFinite(amount) || amount <= 0) {
    req.flash("error", "Enter an amount greater than zero.");
    return res.redirect("/accounts");
  }

  try {
    await createTransfer({
      userId: req.session.user.id,
      fromAccountId: req.body.fromAccountId,
      toAccountId: req.body.toAccountId,
      // Entered in the display currency; store in the account's base currency,
      // same rule as an ordinary transaction.
      amount: toBase(req.session.user, amount),
      note: (req.body.note || "").trim() || null,
      occurredOn: req.body.occurredOn || today()
    });

    req.flash("success", "Transfer recorded.");
    return res.redirect("/accounts");
  } catch (error) {
    return next(error);
  }
}

export async function removeTransfer(req, res, next) {
  try {
    const removed = await deleteTransfer(
      Number(req.params.id),
      req.session.user.id
    );

    req.flash(
      removed ? "success" : "error",
      removed ? "Transfer deleted." : "Transfer not found."
    );
    return res.redirect(req.get("referer") || "/accounts");
  } catch (error) {
    return next(error);
  }
}
