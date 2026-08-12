// Where a business trades, and what that place taxes it.
//
// Until now a business carried one number — an income tax rate — and nothing
// else about where it was. That is enough for one shop in one country and
// nothing else. A group with a branch in Kampala and another in Lagos owes two
// different taxes at two different rates, calls them different things, and
// files them separately, and an app that models that as "30%" is not modelling
// it at all.
//
// So a business now names a jurisdiction, and the jurisdiction says what is
// owed. The rates below are the ordinary headline ones and they are a starting
// point, not tax advice: rates change, thresholds and exemptions exist, and the
// app says so where it shows them. Every one can be overridden per business,
// because the exception is the normal case in tax.
//
// Pure. No database, no clock, no network.

const round = (n) => Math.round(Number(n) * 100) / 100;

// The consumption tax most of the world charges on a sale goes by different
// names — VAT here, GST there, sales tax somewhere else — and the difference is
// not only cosmetic. VAT and GST are charged on the way out and reclaimed on
// the way in, so what a business owes is the difference between the two. US
// sales tax is charged to the final buyer only and is not reclaimable, so a
// business holds all of what it collected. `reclaimable` is what tells the
// arithmetic below which of those two worlds it is in.
export const JURISDICTIONS = {
  KE: {
    name: "Kenya", currency: "KES",
    salesTax: { label: "VAT", rate: 16, reclaimable: true },
    incomeTax: { label: "Corporation tax", rate: 30 },
    authority: "KRA"
  },
  UG: {
    name: "Uganda", currency: "UGX",
    salesTax: { label: "VAT", rate: 18, reclaimable: true },
    incomeTax: { label: "Corporation tax", rate: 30 },
    authority: "URA"
  },
  TZ: {
    name: "Tanzania", currency: "TZS",
    salesTax: { label: "VAT", rate: 18, reclaimable: true },
    incomeTax: { label: "Corporation tax", rate: 30 },
    authority: "TRA"
  },
  RW: {
    name: "Rwanda", currency: "RWF",
    salesTax: { label: "VAT", rate: 18, reclaimable: true },
    incomeTax: { label: "Corporation tax", rate: 28 },
    authority: "RRA"
  },
  NG: {
    name: "Nigeria", currency: "NGN",
    salesTax: { label: "VAT", rate: 7.5, reclaimable: true },
    incomeTax: { label: "Companies income tax", rate: 30 },
    authority: "FIRS"
  },
  ZA: {
    name: "South Africa", currency: "ZAR",
    salesTax: { label: "VAT", rate: 15, reclaimable: true },
    incomeTax: { label: "Corporate income tax", rate: 27 },
    authority: "SARS"
  },
  GB: {
    name: "United Kingdom", currency: "GBP",
    salesTax: { label: "VAT", rate: 20, reclaimable: true },
    incomeTax: { label: "Corporation tax", rate: 25 },
    authority: "HMRC"
  },
  IN: {
    name: "India", currency: "INR",
    salesTax: { label: "GST", rate: 18, reclaimable: true },
    incomeTax: { label: "Corporate tax", rate: 25 },
    authority: "CBIC"
  },
  AE: {
    name: "United Arab Emirates", currency: "AED",
    salesTax: { label: "VAT", rate: 5, reclaimable: true },
    incomeTax: { label: "Corporate tax", rate: 9 },
    authority: "FTA"
  },
  US: {
    name: "United States", currency: "USD",
    // Set per state and per city, so there is no national figure to put here.
    // Nothing is reclaimable: sales tax is charged to the final buyer, and a
    // business that collected it is holding somebody else's money in full.
    salesTax: { label: "Sales tax", rate: 0, reclaimable: false, varies: true },
    incomeTax: { label: "Federal corporate tax", rate: 21 },
    authority: "IRS"
  }
};

export const JURISDICTION_CODES = Object.keys(JURISDICTIONS);
export const isJurisdiction = (code) => Object.hasOwn(JURISDICTIONS, code);
export const jurisdictionOf = (code) => JURISDICTIONS[code] || null;

// The rates a business actually uses: its jurisdiction's, unless it has said
// otherwise. An override of 0 is a real answer — a business can be zero-rated —
// so null is the only thing that means "use the default".
export function ratesFor(business) {
  const place = JURISDICTIONS[business?.jurisdiction] || JURISDICTIONS.KE;
  const incomeOverride = business?.income_tax_rate;

  return {
    code: business?.jurisdiction || "KE",
    ...place,
    incomeTax: {
      ...place.incomeTax,
      rate: incomeOverride == null ? place.incomeTax.rate : Number(incomeOverride),
      overridden: incomeOverride != null && Number(incomeOverride) !== place.incomeTax.rate
    },
    salesTax: {
      ...place.salesTax,
      rate: business?.sales_tax_rate == null
        ? place.salesTax.rate
        : Number(business.sales_tax_rate),
      overridden: business?.sales_tax_rate != null &&
        Number(business.sales_tax_rate) !== place.salesTax.rate
    }
  };
}

// Tax on top of a net price.
export function addSalesTax(net, rate) {
  const tax = round(Number(net) * (Number(rate) / 100));
  return { net: round(net), tax, gross: round(Number(net) + tax) };
}

// And the reverse, for a price that already includes it — which is how prices
// are usually quoted in a VAT country, and the direction people get wrong:
// taking 16% off a gross figure is not the same as the tax that was added.
export function extractSalesTax(gross, rate) {
  const divisor = 1 + Number(rate) / 100;
  const net = round(Number(gross) / divisor);
  return { net, tax: round(Number(gross) - net), gross: round(gross) };
}

// What is owed to the tax authority on consumption tax for a period.
//
// Where the tax is reclaimable, a business is a collector rather than a payer:
// it hands over what it charged less what it was charged. That figure can be
// negative, and a negative is not a debt — it is a refund owed BACK, which is
// worth saying plainly because it is money businesses forget to claim.
export function salesTaxPosition({ outputTax = 0, inputTax = 0, reclaimable = true }) {
  const collected = round(outputTax);
  const paid = reclaimable ? round(inputTax) : 0;
  const net = round(collected - paid);

  return {
    collected,
    reclaimable: paid,
    net: Math.abs(net),
    // Which direction the money goes. A collector who charged less than they
    // were charged is owed the difference.
    owed: net >= 0,
    refundDue: net < 0
  };
}

// --- Consolidation ---

// A group's figures, each entity converted into the parent's currency and then
// added up.
//
// ★ Converting BEFORE adding is the whole point and the easy thing to get
// wrong. Summing shillings and nairas into one number and converting the total
// is meaningless arithmetic that produces a confident figure. `rateFor` is
// injected rather than imported so this stays pure and a test can pin the rates.
export function consolidate({ entities = [], currency, rateFor }) {
  const rows = entities.map((entity) => {
    const rate = entity.currency === currency ? 1 : rateFor(entity.currency, currency);
    const convert = (n) => round(Number(n || 0) * rate);

    return {
      business: entity.business,
      currency: entity.currency,
      rate,
      // Kept in both, so a subsidiary's own books are still readable in the
      // money they were actually kept in.
      own: entity.figures,
      converted: {
        revenue: convert(entity.figures.revenue),
        expenses: convert(entity.figures.expenses),
        netProfit: convert(entity.figures.netProfit),
        assets: convert(entity.figures.assets),
        liabilities: convert(entity.figures.liabilities)
      }
    };
  });

  const total = (field) => round(rows.reduce((sum, r) => sum + r.converted[field], 0));

  return {
    currency,
    rows,
    totals: {
      revenue: total("revenue"),
      expenses: total("expenses"),
      netProfit: total("netProfit"),
      assets: total("assets"),
      liabilities: total("liabilities"),
      equity: round(total("assets") - total("liabilities"))
    },
    // Whether anything had to be converted at all, so a single-currency group
    // is not made to read like a foreign-exchange problem it does not have.
    multiCurrency: rows.some((r) => r.currency !== currency),
    entityCount: rows.length
  };
}
