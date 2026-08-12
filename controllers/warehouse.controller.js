import {
  createLocation,
  ensureDefaultLocation,
  heldAt,
  listLocations,
  listTransfers,
  makeDefault,
  placeUnplaced,
  stockRows,
  transferStock
} from "../db/queries/warehouse.js";
import { listProducts } from "../db/queries/inventory.js";
import { getBusiness } from "../db/queries/business.js";
import { checkTransfer, restockSuggestions, stockReport } from "../utils/warehouse.js";
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

export async function showLocations(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const userId = req.session.user.id;
    // A business that has never opened this page still has somewhere for stock
    // to land, so the rest of the app never has to ask whether one exists.
    await ensureDefaultLocation(business.id, userId);

    const [locations, products, rows, transfers] = await Promise.all([
      listLocations(business.id, userId),
      listProducts(business.id, userId),
      stockRows(business.id, userId),
      listTransfers(business.id, userId)
    ]);

    const report = stockReport(products, rows, locations);

    return res.render("locations", {
      title: `${business.name} · Stock locations`,
      business,
      locations,
      products,
      report,
      transfers,
      suggestions: restockSuggestions(report),
      today: today()
    });
  } catch (error) {
    return next(error);
  }
}

export async function addLocation(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/locations`;
  const name = (req.body.name || "").trim().slice(0, 120);

  if (!name) {
    req.flash("error", "A location needs a name.");
    return res.redirect(back);
  }

  try {
    await createLocation({
      businessId: business.id,
      userId: req.session.user.id,
      name,
      code: (req.body.code || "").trim().slice(0, 20) || null,
      notes: (req.body.notes || "").trim().slice(0, 200) || null
    });
    req.flash("success", `${name} added. Move stock into it below.`);
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

export async function setDefault(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    const updated = await makeDefault({
      locationId: Number(req.params.locationId),
      businessId: business.id,
      userId: req.session.user.id
    });

    req.flash(
      "success",
      updated
        ? `${updated.name} is where stock lands from now on.`
        : "That location is not here."
    );
    return res.redirect(`/business/${business.id}/locations`);
  } catch (error) {
    return next(error);
  }
}

export async function moveStock(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/locations`;
  const productId = Number(req.body.productId);
  const fromId = Number(req.body.fromId);
  const toId = Number(req.body.toId);

  try {
    // Checked against what is actually at the source, not against what the
    // form believed when the page was drawn.
    const available = await heldAt(productId, fromId);
    const verdict = checkTransfer({
      quantity: req.body.quantity, available, fromId, toId
    });

    if (!verdict.ok) {
      req.flash("error", verdict.reason);
      return res.redirect(back);
    }

    const out = await transferStock({
      businessId: business.id,
      userId: req.session.user.id,
      productId,
      fromId,
      toId,
      quantity: verdict.amount,
      note: (req.body.note || "").trim().slice(0, 200) || null,
      movedOn: req.body.movedOn || today()
    });

    if (!out.ok) {
      // Somebody moved the same units between the check and the write.
      req.flash("error", `Only ${out.available} were still there when the move ran.`);
      return res.redirect(back);
    }

    req.flash("success", `${verdict.amount} moved. The total on hand is unchanged.`);
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

// Stock that arrived before locations existed, or through a path that named
// none, gets a home. Idempotent, so the button is safe to press twice.
export async function placeEverything(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    const wanted = req.body.locationId ? Number(req.body.locationId) : null;
    const { placed, location } = await placeUnplaced({
      businessId: business.id,
      userId: req.session.user.id,
      locationId: wanted
    });

    req.flash(
      "success",
      placed > 0
        ? `${placed} product${placed === 1 ? "" : "s"} placed at ${location.name}.`
        : "Nothing was unplaced — every unit is already somewhere."
    );
    return res.redirect(`/business/${business.id}/locations`);
  } catch (error) {
    return next(error);
  }
}
