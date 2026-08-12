import {
  createSubsidiary,
  groupFigures,
  groupFor,
  setParent,
  setPlace,
  taxableTotals
} from "../db/queries/group.js";
import { getBusiness } from "../db/queries/business.js";
import { getRate } from "../services/fx.js";
import { CURRENCIES, DEFAULT_CURRENCY } from "../utils/currencies.js";
import {
  JURISDICTIONS,
  JURISDICTION_CODES,
  consolidate,
  extractSalesTax,
  isJurisdiction,
  ratesFor,
  salesTaxPosition
} from "../utils/jurisdictions.js";

async function requireBusiness(req, res) {
  const business = await getBusiness(Number(req.params.id), req.session.user.id);
  if (!business) {
    req.flash("error", "Business not found.");
    res.redirect("/business");
    return null;
  }
  return business;
}

const currencyOf = (business, user) =>
  business.base_currency || user.base_currency || user.currency || DEFAULT_CURRENCY;

export async function showGroup(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const user = req.session.user;
    const { members, parent } = await groupFor(business.id, user.id);
    const figures = await groupFigures(members.map((m) => m.id), user.id);

    // The parent's currency is what the group reports in — its books are the
    // ones the group's own figures live in.
    const reportingCurrency = currencyOf(parent || business, user);

    const group = consolidate({
      currency: reportingCurrency,
      rateFor: (from, to) => getRate(from, to),
      entities: members.map((m) => ({
        business: m,
        currency: currencyOf(m, user),
        figures: figures.get(m.id)
      }))
    });

    return res.render("group", {
      title: `${business.name} · Group`,
      business,
      parent,
      members,
      group,
      reportingCurrency,
      rates: ratesFor(business),
      jurisdictions: JURISDICTIONS,
      jurisdictionCodes: JURISDICTION_CODES,
      currencies: CURRENCIES
    });
  } catch (error) {
    return next(error);
  }
}

export async function addSubsidiary(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/group`;
  const name = (req.body.name || "").trim().slice(0, 120);

  if (!name) {
    req.flash("error", "A branch needs a name.");
    return res.redirect(back);
  }

  try {
    const jurisdiction = isJurisdiction(req.body.jurisdiction) ? req.body.jurisdiction : null;
    // A branch defaults to the currency of wherever it trades, which is right
    // far more often than defaulting to the parent's.
    const currency = CURRENCIES.some((c) => c.code === req.body.currency)
      ? req.body.currency
      : (jurisdiction ? JURISDICTIONS[jurisdiction].currency : null);

    await createSubsidiary({
      parentId: business.id,
      userId: req.session.user.id,
      name,
      industry: (req.body.industry || "").trim().slice(0, 80) || business.industry,
      jurisdiction,
      currency
    });

    req.flash("success", `${name} opened as a branch of ${business.name}.`);
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

export async function savePlace(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/group`;

  if (!isJurisdiction(req.body.jurisdiction)) {
    req.flash("error", "Choose where this business trades.");
    return res.redirect(back);
  }

  try {
    // A blank rate means "whatever this country charges", which is a different
    // thing from zero — and zero is itself a real rate, so it must survive.
    const rate = (value) => {
      if (value === "" || value == null) return null;
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 100) : null;
    };

    const currency = CURRENCIES.some((c) => c.code === req.body.currency)
      ? req.body.currency
      : JURISDICTIONS[req.body.jurisdiction].currency;

    await setPlace({
      businessId: business.id,
      userId: req.session.user.id,
      jurisdiction: req.body.jurisdiction,
      currency,
      incomeTaxRate: rate(req.body.incomeTaxRate),
      salesTaxRate: rate(req.body.salesTaxRate)
    });

    const place = JURISDICTIONS[req.body.jurisdiction];
    req.flash(
      "success",
      `${business.name} now trades in ${place.name} — ${place.incomeTax.label} at ` +
      `${place.incomeTax.rate}% and ${place.salesTax.label}` +
      `${place.salesTax.varies ? " set locally" : ` at ${place.salesTax.rate}%`}, ` +
      `unless you have overridden them.`
    );
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

export async function reparent(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/group`;

  try {
    const wanted = req.body.parentId ? Number(req.body.parentId) : null;
    const out = await setParent({
      businessId: Number(req.params.memberId),
      userId: req.session.user.id,
      parentId: wanted
    });

    if (!out.ok) {
      req.flash("error", out.reason);
      return res.redirect(back);
    }

    req.flash(
      "success",
      wanted
        ? `${out.business.name} moved under its new parent.`
        : `${out.business.name} is now a business in its own right.`
    );
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

// The consumption-tax position, shown on the existing tax page's terms but
// worked out from where the business actually trades.
export async function taxSummaryFor(business, userId) {
  const rates = ratesFor(business);
  const totals = await taxableTotals(business.id, userId);

  // Amounts are recorded tax-inclusive, so the tax is taken back out of the
  // totals rather than read off a column that does not exist.
  const output = extractSalesTax(totals.income, rates.salesTax.rate);
  const input = extractSalesTax(totals.deductible, rates.salesTax.rate);

  return {
    rates,
    totals,
    output,
    input,
    position: salesTaxPosition({
      outputTax: output.tax,
      inputTax: input.tax,
      reclaimable: rates.salesTax.reclaimable
    })
  };
}
