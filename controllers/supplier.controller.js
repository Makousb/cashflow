import {
  addCatalogProduct,
  adjustCatalogStock,
  createSupplier,
  getSupplier,
  listCatalog,
  listSuppliers,
  markOrderPaid,
  removeCatalogProduct,
  supplierLedger,
  updateSupplierProfile
} from "../db/queries/suppliers.js";
import {
  advanceOrder,
  getOrder,
  listBuyersFor,
  listOrdersForSupplier,
  setPartnershipStatus,
  shipSupplyOrder
} from "../db/queries/supply.js";
import { publish } from "../services/realtime.js";
import { toBase } from "../services/fx.js";
import { addDays, summarizeOrders } from "../utils/supply.js";
import { today } from "../utils/dates.js";

async function requireSupplier(req, res) {
  const supplier = await getSupplier(Number(req.params.id), req.session.user.id);
  if (!supplier) {
    req.flash("error", "Supplier not found.");
    res.redirect("/supplier");
    return null;
  }
  return supplier;
}

// The list of supplier accounts this login owns.
export async function showSupplierHub(req, res, next) {
  try {
    const suppliers = await listSuppliers(req.session.user.id);
    return res.render("supplier-hub", {
      title: "Suppliers",
      suppliers
    });
  } catch (error) {
    return next(error);
  }
}

export async function addSupplier(req, res, next) {
  const name = (req.body.name || "").trim();
  if (!name) {
    req.flash("error", "Give the supplier a name.");
    return res.redirect("/supplier");
  }

  try {
    const supplier = await createSupplier({
      userId: req.session.user.id,
      name,
      industry: (req.body.industry || "").trim() || null,
      leadTimeDays: Number.parseInt(req.body.leadTimeDays, 10) || 3
    });
    req.flash("success", `${supplier.name} created — share ${supplier.supply_code} with buyers.`);
    return res.redirect(`/supplier/${supplier.id}`);
  } catch (error) {
    return next(error);
  }
}

export async function showSupplier(req, res, next) {
  try {
    const supplier = await requireSupplier(req, res);
    if (!supplier) return undefined;

    const [catalog, orders, ledger, buyers] = await Promise.all([
      listCatalog(supplier.id),
      listOrdersForSupplier(supplier.id),
      supplierLedger(supplier.id),
      listBuyersFor(supplier.id)
    ]);

    return res.render("supplier", {
      title: `${supplier.name} · Supplier`,
      supplier,
      catalog,
      orders,
      ledger,
      buyers,
      // A buyer who has asked to connect is waiting on this page and nowhere
      // else, so they are pulled out rather than left to be spotted in a list.
      requests: buyers.filter((b) => b.status === "pending"),
      summary: summarizeOrders(orders)
    });
  } catch (error) {
    return next(error);
  }
}

// Accept or decline a buyer's request to connect.
//
// This lives here, on the supplier, because the supplier is who decides — and
// because it is the only side that can. A partnership row points at
// suppliers(id); the business-side route that used to answer these was left
// behind when suppliers stopped being businesses, and matched the request's
// supplier_id against a businesses(id). Those are different id spaces, so it
// could never match, no page ever linked to it, and every request a real buyer
// sent stayed pending for good.
export async function respondToRequest(req, res, next) {
  const supplier = await requireSupplier(req, res);
  if (!supplier) return undefined;

  const accept = req.body.decision === "accept";

  try {
    const partnership = await setPartnershipStatus(
      Number(req.params.partnerId),
      supplier.id,
      accept ? "active" : "declined"
    );

    // The buyer's supply page is watching a live stream; tell it either way so
    // the request stops reading "pending" without them reloading.
    if (partnership) {
      publish(partnership.buyer_business_id, "partner", {
        status: partnership.status,
        supplierName: supplier.name
      });
    }

    req.flash(
      partnership ? "success" : "error",
      partnership
        ? accept
          ? "Buyer connected — they can now order from your catalog."
          : "Request declined."
        : "Request not found."
    );
    return res.redirect(`/supplier/${supplier.id}`);
  } catch (error) {
    return next(error);
  }
}

export async function saveProfile(req, res, next) {
  const supplier = await requireSupplier(req, res);
  if (!supplier) return undefined;

  const leadTime = Number.parseInt(req.body.leadTimeDays, 10);
  try {
    await updateSupplierProfile(supplier.id, req.session.user.id, {
      acceptingOrders: req.body.acceptingOrders === "on",
      leadTimeDays: Number.isFinite(leadTime) ? Math.min(Math.max(leadTime, 0), 365) : 3
    });
    req.flash("success", "Profile updated.");
    return res.redirect(`/supplier/${supplier.id}`);
  } catch (error) {
    return next(error);
  }
}

export async function addProduct(req, res, next) {
  const supplier = await requireSupplier(req, res);
  if (!supplier) return undefined;

  const user = req.session.user;
  const name = (req.body.name || "").trim();
  if (!name) {
    req.flash("error", "Give the item a name.");
    return res.redirect(`/supplier/${supplier.id}`);
  }

  const numeric = (v) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  try {
    await addCatalogProduct({
      supplierId: supplier.id,
      userId: user.id,
      name,
      sku: (req.body.sku || "").trim() || null,
      quantity: numeric(req.body.quantity),
      // Money is stored in the owner's base currency, like everywhere else.
      unitCost: toBase(user, numeric(req.body.unitCost)),
      salePrice: toBase(user, numeric(req.body.salePrice))
    });
    req.flash("success", "Added to the catalog.");
    return res.redirect(`/supplier/${supplier.id}`);
  } catch (error) {
    return next(error);
  }
}

export async function restockProduct(req, res, next) {
  const supplier = await requireSupplier(req, res);
  if (!supplier) return undefined;

  const delta = Number.parseFloat(req.body.delta);
  if (!Number.isFinite(delta) || delta === 0) {
    req.flash("error", "Enter how much to add or remove.");
    return res.redirect(`/supplier/${supplier.id}`);
  }

  try {
    await adjustCatalogStock(Number(req.params.productId), req.session.user.id, delta);
    req.flash("success", "Stock updated.");
    return res.redirect(`/supplier/${supplier.id}`);
  } catch (error) {
    return next(error);
  }
}

export async function removeProduct(req, res, next) {
  const supplier = await requireSupplier(req, res);
  if (!supplier) return undefined;

  try {
    await removeCatalogProduct(Number(req.params.productId), req.session.user.id);
    req.flash("success", "Removed from the catalog.");
    return res.redirect(`/supplier/${supplier.id}`);
  } catch (error) {
    return next(error);
  }
}

// A supplier keeps no books here, so settlement is recorded on the order.
export async function markPaid(req, res, next) {
  const supplier = await requireSupplier(req, res);
  if (!supplier) return undefined;

  try {
    const order = await markOrderPaid(Number(req.params.orderId), supplier.id);
    req.flash(
      order ? "success" : "error",
      order ? `Order #${order.id} marked paid.` : "That order is not awaiting payment."
    );
    return res.redirect(`/supplier/${supplier.id}`);
  } catch (error) {
    return next(error);
  }
}

// Fulfilment. These used to live on the business's supply page, back when a
// supplier was a business; they belong to the supplier account now, and are
// authorised by owning the supplier rather than by owning a business.
async function requireOwnOrder(req, res, supplier) {
  const order = await getOrder(Number(req.params.orderId));
  if (!order || order.supplier_id !== supplier.id) {
    req.flash("error", "Order not found.");
    res.redirect(`/supplier/${supplier.id}`);
    return null;
  }
  return order;
}

export async function confirmOrder(req, res, next) {
  const supplier = await requireSupplier(req, res);
  if (!supplier) return undefined;

  try {
    const existing = await requireOwnOrder(req, res, supplier);
    if (!existing) return undefined;

    const promisedOn =
      ((req.body && req.body.promisedOn) || "").trim() ||
      addDays(today(), supplier.lead_time_days || 3);

    const order = await advanceOrder(existing.id, {
      from: ["placed"], status: "confirmed", stampColumn: "confirmed_at",
      fields: { promised_on: promisedOn }
    });

    req.flash(
      order ? "success" : "error",
      order ? "Order confirmed." : "This order can no longer be confirmed."
    );
    return res.redirect(`/supplier/${supplier.id}`);
  } catch (error) {
    return next(error);
  }
}

export async function shipOrder(req, res, next) {
  const supplier = await requireSupplier(req, res);
  if (!supplier) return undefined;

  try {
    const existing = await requireOwnOrder(req, res, supplier);
    if (!existing) return undefined;

    const order = await shipSupplyOrder(
      existing.id, (req.body.tracking || "").trim() || null
    );
    req.flash(
      order ? "success" : "error",
      order ? "Shipped — the units have left your catalog." : "This order can no longer be shipped."
    );
    return res.redirect(`/supplier/${supplier.id}`);
  } catch (error) {
    return next(error);
  }
}

export async function markDelivered(req, res, next) {
  const supplier = await requireSupplier(req, res);
  if (!supplier) return undefined;

  try {
    const existing = await requireOwnOrder(req, res, supplier);
    if (!existing) return undefined;

    const order = await advanceOrder(existing.id, {
      from: ["shipped"], status: "delivered", stampColumn: "delivered_at"
    });
    req.flash(
      order ? "success" : "error",
      order ? "Marked delivered." : "This order is not out for delivery."
    );
    return res.redirect(`/supplier/${supplier.id}`);
  } catch (error) {
    return next(error);
  }
}

export async function declineOrder(req, res, next) {
  const supplier = await requireSupplier(req, res);
  if (!supplier) return undefined;

  try {
    const existing = await requireOwnOrder(req, res, supplier);
    if (!existing) return undefined;

    const order = await advanceOrder(existing.id, {
      from: ["placed", "confirmed"], status: "declined", stampColumn: "closed_at"
    });
    req.flash(
      order ? "success" : "error",
      order ? "Order declined." : "An order that has shipped cannot be declined."
    );
    return res.redirect(`/supplier/${supplier.id}`);
  } catch (error) {
    return next(error);
  }
}
