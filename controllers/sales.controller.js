import { getBusiness } from "../db/queries/business.js";
import { listProducts, lowStockProducts } from "../db/queries/inventory.js";
import {
  createSale,
  listSaleItems,
  listSales,
  salesSummary,
  topSellers,
  voidSale
} from "../db/queries/sales.js";
import { toBase } from "../services/fx.js";
import { CURRENCY_BY_CODE, DEFAULT_CURRENCY } from "../utils/currencies.js";
import { addDays } from "../utils/supply.js";
import { today } from "../utils/dates.js";

// Days a credit customer gets to pay.
const CREDIT_TERMS_DAYS = 14;

async function requireBusiness(req, res) {
  const business = await getBusiness(Number(req.params.id), req.session.user.id);
  if (!business) {
    req.flash("error", "Business not found.");
    res.redirect("/business");
    return null;
  }
  return business;
}

export async function showSales(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const userId = req.session.user.id;
    const [products, sales, summary, sellers, lowStock] = await Promise.all([
      listProducts(business.id, userId),
      listSales(business.id, userId),
      salesSummary(business.id, userId),
      topSellers(business.id, userId),
      lowStockProducts(business.id, userId)
    ]);

    // One query for every line on the page, grouped back onto its sale.
    const items = await listSaleItems(sales.map((s) => s.id));
    const itemsBySale = new Map();
    for (const item of items) {
      if (!itemsBySale.has(item.sale_id)) itemsBySale.set(item.sale_id, []);
      itemsBySale.get(item.sale_id).push(item);
    }

    return res.render("sales", {
      title: `${business.name} · Sales`,
      business,
      products,
      sales: sales.map((s) => ({ ...s, items: itemsBySale.get(s.id) || [] })),
      summary,
      sellers,
      lowStock,
      today: today(),
      creditTermsDays: CREDIT_TERMS_DAYS,
      // The till total is added up in the browser, so it needs the same symbol
      // and precision the server would have used.
      currencyInfo:
        CURRENCY_BY_CODE.get(req.session.user.currency || DEFAULT_CURRENCY) ||
        { symbol: req.session.user.currency || DEFAULT_CURRENCY, decimals: 2 }
    });
  } catch (error) {
    return next(error);
  }
}

export async function recordSale(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const user = req.session.user;
  const back = `/business/${business.id}/sales`;

  try {
    const products = await listProducts(business.id, user.id);

    // Quantities arrive as qty[p<product id>] — the "p" stops the form parser
    // treating numeric keys as array indexes and renumbering them.
    const quantities = req.body.qty || {};
    const lines = [];

    for (const product of products) {
      const quantity = Number.parseFloat(quantities[`p${product.id}`]);
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      lines.push({ productId: product.id, name: product.name, quantity });
    }

    // Something not held in stock — a service, a one-off. Priced by hand.
    const customName = (req.body.customName || "").trim();
    const customQty = Number.parseFloat(req.body.customQuantity);
    const customPrice = Number.parseFloat(req.body.customPrice);
    if (customName && Number.isFinite(customQty) && customQty > 0) {
      lines.push({
        productId: null,
        name: customName,
        quantity: customQty,
        unitPrice: toBase(user, Number.isFinite(customPrice) ? customPrice : 0)
      });
    }

    if (lines.length === 0) {
      req.flash("error", "Add a quantity to at least one item.");
      return res.redirect(back);
    }

    const payment = req.body.payment === "credit" ? "credit" : "cash";
    const occurredOn = req.body.occurredOn || today();

    const result = await createSale({
      businessId: business.id,
      userId: user.id,
      customer: (req.body.customer || "").trim() || null,
      payment,
      note: (req.body.note || "").trim() || null,
      occurredOn,
      dueOn: addDays(occurredOn, CREDIT_TERMS_DAYS),
      lines
    });

    if (result.shortfalls) {
      const detail = result.shortfalls
        .map((s) => `${s.name} (${s.available} left, ${s.wanted} wanted)`)
        .join(", ");
      req.flash(
        "error",
        `Not enough stock: ${detail}. Adjust the stock count or sell fewer.`
      );
      return res.redirect(back);
    }

    const { sale, items } = result;
    const units = items.reduce((sum, i) => sum + i.quantity, 0);

    // Selling is what makes stock run out, so say so while the seller is still
    // looking — this is what drives the next purchase order.
    const soldIds = items.map((i) => i.productId).filter(Boolean);
    const nowLow = (await lowStockProducts(business.id, user.id)).filter((p) =>
      soldIds.includes(p.id)
    );
    if (nowLow.length > 0) {
      req.flash(
        "error",
        `Low on stock after this sale: ${nowLow
          .map((p) => `${p.name} (${Number(p.quantity)} left)`)
          .join(", ")}. Reorder from Inventory or the supply chain.`
      );
    }

    req.flash(
      "success",
      payment === "credit"
        ? `Sale #${sale.id} recorded — ${units} unit(s) off the shelf, invoice raised.`
        : `Sale #${sale.id} recorded — ${units} unit(s) off the shelf.`
    );
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

export async function removeSale(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    const result = await voidSale(Number(req.params.saleId), req.session.user.id);

    if (result.missing) {
      req.flash("error", "Sale not found.");
    } else if (result.settled) {
      req.flash(
        "error",
        "That sale's invoice has already been paid — reverse it from Bills & invoices instead."
      );
    } else {
      req.flash("success", "Sale voided — stock restored and the income unbooked.");
    }
    return res.redirect(`/business/${business.id}/sales`);
  } catch (error) {
    return next(error);
  }
}
