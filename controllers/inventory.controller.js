import {
  addBusinessTransaction,
  getBusiness
} from "../db/queries/business.js";
import {
  adjustProductStock,
  createProduct,
  createPurchaseOrder,
  deleteProduct,
  deletePurchaseOrder,
  getProduct,
  inventorySummary,
  listProducts,
  listPurchaseOrders,
  lowStockProducts,
  receivePurchaseOrder
} from "../db/queries/inventory.js";
import { toBase } from "../services/fx.js";
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

// How many units to order for a low-stock product.
function orderQuantityFor(product) {
  const configured = Number(product.reorder_qty);
  if (configured > 0) {
    return configured;
  }
  const gap = Number(product.reorder_point) - Number(product.quantity);
  return Math.max(Math.ceil(gap) + 1, 1);
}

export async function showInventory(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const userId = req.session.user.id;
    const [products, summary, lowStock, orders] = await Promise.all([
      listProducts(business.id, userId),
      inventorySummary(business.id, userId),
      lowStockProducts(business.id, userId),
      listPurchaseOrders(business.id, userId)
    ]);

    return res.render("inventory", {
      title: `${business.name} · Inventory`,
      business,
      products,
      summary,
      lowStock: lowStock.map((p) => ({ ...p, order_qty: orderQuantityFor(p) })),
      orders,
      today: today()
    });
  } catch (error) {
    return next(error);
  }
}

export async function addProduct(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const name = (req.body.name || "").trim();
  if (!name) {
    req.flash("error", "Give the product a name.");
    return res.redirect(`/business/${business.id}/inventory`);
  }

  const numeric = (v) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  try {
    await createProduct({
      businessId: business.id,
      userId: req.session.user.id,
      name,
      sku: (req.body.sku || "").trim() || null,
      quantity: numeric(req.body.quantity),
      // Money fields convert to base; counts (quantity/reorder) stay as-is.
      unitCost: toBase(req.session.user, numeric(req.body.unitCost)),
      salePrice: toBase(req.session.user, numeric(req.body.salePrice)),
      reorderPoint: numeric(req.body.reorderPoint),
      reorderQty: numeric(req.body.reorderQty),
      supplier: (req.body.supplier || "").trim() || null
    });
    req.flash("success", "Product added.");
    return res.redirect(`/business/${business.id}/inventory`);
  } catch (error) {
    return next(error);
  }
}

export async function restockProduct(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const delta = Number.parseFloat(req.body.delta);
  if (!Number.isFinite(delta) || delta === 0) {
    req.flash("error", "Enter how much to add or remove.");
    return res.redirect(`/business/${business.id}/inventory`);
  }

  try {
    await adjustProductStock(Number(req.params.pid), req.session.user.id, delta);
    req.flash("success", "Stock updated.");
    return res.redirect(`/business/${business.id}/inventory`);
  } catch (error) {
    return next(error);
  }
}

export async function removeProduct(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    await deleteProduct(Number(req.params.pid), req.session.user.id);
    req.flash("success", "Product removed.");
    return res.redirect(`/business/${business.id}/inventory`);
  } catch (error) {
    return next(error);
  }
}

export async function createReorder(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    const low = await lowStockProducts(business.id, req.session.user.id);
    if (low.length === 0) {
      req.flash("error", "Nothing is low on stock right now.");
      return res.redirect(`/business/${business.id}/inventory`);
    }

    const items = low.map((p) => ({
      productId: p.id,
      name: p.name,
      quantity: orderQuantityFor(p),
      unitCost: Number(p.unit_cost)
    }));

    await createPurchaseOrder({
      businessId: business.id,
      userId: req.session.user.id,
      supplier: null,
      note: "Auto reorder of low-stock items",
      items
    });

    req.flash("success", `Purchase order created for ${items.length} item(s).`);
    return res.redirect(`/business/${business.id}/inventory`);
  } catch (error) {
    return next(error);
  }
}

export async function orderProduct(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const quantity = Number.parseFloat(req.body.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    req.flash("error", "Enter a quantity to order.");
    return res.redirect(`/business/${business.id}/inventory`);
  }

  try {
    const product = await getProduct(Number(req.body.productId), req.session.user.id);
    if (!product) {
      req.flash("error", "Pick a product to order.");
      return res.redirect(`/business/${business.id}/inventory`);
    }

    await createPurchaseOrder({
      businessId: business.id,
      userId: req.session.user.id,
      supplier: product.supplier,
      note: null,
      items: [
        {
          productId: product.id,
          name: product.name,
          quantity,
          unitCost: Number(product.unit_cost)
        }
      ]
    });

    req.flash("success", `Ordered ${quantity} × ${product.name}.`);
    return res.redirect(`/business/${business.id}/inventory`);
  } catch (error) {
    return next(error);
  }
}

export async function receiveOrder(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    const order = await receivePurchaseOrder(
      Number(req.params.oid),
      req.session.user.id,
      today()
    );

    if (!order) {
      req.flash("error", "Order not found or already received.");
      return res.redirect(`/business/${business.id}/inventory`);
    }

    // Receiving stock is money spent — post it to the business ledger.
    if (Number(order.total) > 0) {
      await addBusinessTransaction({
        businessId: business.id,
        userId: req.session.user.id,
        kind: "expense",
        amount: Number(order.total),
        category: "Cost of Goods",
        note: `Stock received (PO #${order.id})`,
        occurredOn: today()
      });
    }

    req.flash("success", "Order received — stock updated and cost recorded.");
    return res.redirect(`/business/${business.id}/inventory`);
  } catch (error) {
    return next(error);
  }
}

export async function removeOrder(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    await deletePurchaseOrder(Number(req.params.oid), req.session.user.id);
    req.flash("success", "Purchase order deleted.");
    return res.redirect(`/business/${business.id}/inventory`);
  } catch (error) {
    return next(error);
  }
}
