import { createBill, createInvoice } from "../db/queries/accounting.js";
import { getBusiness, listBusinesses } from "../db/queries/business.js";
import { listProducts } from "../db/queries/inventory.js";
import {
  addMessage,
  advanceOrder,
  createSupplyOrder,
  deletePartnership,
  deliveryHistory,
  ensureSupplyCode,
  findBusinessByCode,
  getOrder,
  getPartnership,
  getTradingBusiness,
  linkOrderDocument,
  listBuyersFor,
  listItemsFor,
  listMessages,
  listOrderItems,
  listOrdersFor,
  listSuppliersFor,
  receiveSupplyOrder,
  requestPartnership,
  setPartnershipStatus,
  shipSupplyOrder,
  supplierCatalog,
  updateSupplyProfile
} from "../db/queries/supply.js";
import { publish, subscribe } from "../services/realtime.js";
import { convert } from "../services/fx.js";
import { CURRENCY_BY_CODE, DEFAULT_CURRENCY } from "../utils/currencies.js";
import { formatCurrency } from "../utils/currency.js";
import { formatDate, today, toISODate } from "../utils/dates.js";
import {
  addDays,
  estimateEta,
  isLate,
  lateness,
  monthlySeries,
  partnerScorecards,
  progressPercent,
  statusMeta,
  summarizeOrders,
  targetDate,
  timeline,
  topItems,
  transitDays
} from "../utils/supply.js";

// Terms applied to the paperwork an order generates on each side.
const PAYMENT_TERMS_DAYS = 30;

function displayCurrencyOf(user) {
  return user?.currency || user?.base_currency || DEFAULT_CURRENCY;
}

// Formats an amount held in `from` currency into the viewer's display
// currency. Orders are priced in the buyer's currency, so the supplier reading
// the same order sees it converted at the live rate.
function amountFormatter(user) {
  const display = displayCurrencyOf(user);
  return (amount, from) =>
    formatCurrency(convert(amount, from || display, display), display);
}

// Restate an order's money in the viewer's currency so totals from several
// counterparts can be added together.
function inViewerCurrency(orders, user) {
  const display = displayCurrencyOf(user);
  return orders.map((order) => ({
    ...order,
    total: convert(order.total, order.currency, display),
    currency: display
  }));
}

async function requireBusiness(req, res) {
  const business = await getBusiness(Number(req.params.id), req.session.user.id);
  if (!business) {
    req.flash("error", "Business not found.");
    res.redirect("/business");
    return null;
  }
  if (!business.supply_code) {
    business.supply_code = await ensureSupplyCode(business.id);
  }
  return business;
}

// An order is readable and actionable only by the two businesses on it.
async function requireOrder(req, res, business) {
  const order = await getOrder(Number(req.params.orderId));
  const party =
    order &&
    (order.buyer_business_id === business.id ||
      order.supplier_business_id === business.id);

  if (!party) {
    req.flash("error", "Order not found.");
    res.redirect(`/business/${business.id}/supply`);
    return null;
  }
  return order;
}

function roleOn(order, business) {
  return order.buyer_business_id === business.id ? "buyer" : "supplier";
}

// Write a line into the order thread and push it to both sides, so the
// conversation and the order state stay in step for everyone watching.
async function announce(order, { businessId, userId, body, statusChanged = false }) {
  const message = await addMessage({
    orderId: order.id,
    businessId,
    userId,
    kind: statusChanged ? "event" : "message",
    body
  });

  const audience = [order.buyer_business_id, order.supplier_business_id];
  publish(audience, "message", {
    orderId: order.id,
    id: message.id,
    kind: message.kind,
    body: message.body,
    businessId: message.business_id,
    businessName: message.business_name,
    userName: message.user_name,
    createdAt: message.created_at
  });

  if (statusChanged) {
    const meta = statusMeta(order.status);
    const eta = targetDate(order);
    publish(audience, "order", {
      orderId: order.id,
      status: order.status,
      label: meta.label,
      icon: meta.icon,
      badge: meta.badge,
      blurb: meta.blurb,
      progress: progressPercent(order),
      eta: eta ? formatDate(eta) : null,
      note: body
    });
  }

  return message;
}

// --- Supply chain hub ---

export async function showSupplyChain(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const user = req.session.user;
    const [suppliers, buyers, rawOrders, ownBusinesses] = await Promise.all([
      listSuppliersFor(business.id),
      listBuyersFor(business.id),
      listOrdersFor(business.id),
      listBusinesses(user.id)
    ]);

    const orders = inViewerCurrency(rawOrders, user);
    const outgoing = orders.filter((o) => o.role === "buyer");
    const incoming = orders.filter((o) => o.role === "supplier");

    return res.render("supply", {
      title: `${business.name} · Supply chain`,
      business,
      suppliers,
      buyers,
      pendingRequests: buyers.filter((b) => b.status === "pending"),
      outgoing,
      incoming,
      buying: summarizeOrders(outgoing),
      selling: summarizeOrders(incoming),
      otherBusinesses: ownBusinesses.filter((b) => b.id !== business.id),
      showAmount: amountFormatter(user),
      statusMeta,
      targetDate,
      isLate,
      lateness
    });
  } catch (error) {
    return next(error);
  }
}

export async function saveSupplyProfile(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const leadTime = Number.parseInt(req.body.leadTimeDays, 10);

  try {
    await updateSupplyProfile(business.id, req.session.user.id, {
      isSupplier: req.body.isSupplier === "on" || req.body.isSupplier === "true",
      leadTimeDays: Number.isFinite(leadTime) ? Math.min(Math.max(leadTime, 0), 365) : 3
    });
    req.flash("success", "Supplier profile updated.");
    return res.redirect(`/business/${business.id}/supply`);
  } catch (error) {
    return next(error);
  }
}

// --- Trading relationships ---

export async function connectSupplier(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const code = (req.body.code || "").trim();
  const back = `/business/${business.id}/supply`;

  if (!code) {
    req.flash("error", "Enter the supplier's connection code.");
    return res.redirect(back);
  }

  try {
    const supplier = await findBusinessByCode(code);
    if (!supplier) {
      req.flash("error", `No business found with the code ${code}.`);
      return res.redirect(back);
    }
    if (supplier.id === business.id) {
      req.flash("error", "A business cannot supply itself.");
      return res.redirect(back);
    }
    if (!supplier.is_supplier) {
      req.flash("error", `${supplier.name} is not accepting supply orders yet.`);
      return res.redirect(back);
    }

    // Connecting two of your own businesses needs no approval — you are both
    // sides of the request.
    const sameOwner = supplier.user_id === req.session.user.id;
    const partnership = await requestPartnership({
      buyerBusinessId: business.id,
      supplierBusinessId: supplier.id,
      requestedBy: req.session.user.id,
      status: sameOwner ? "active" : "pending"
    });

    publish(supplier.id, "partner", {
      status: partnership.status,
      buyerName: business.name,
      supplierName: supplier.name
    });

    req.flash(
      "success",
      partnership.status === "active"
        ? `Connected to ${supplier.name} — you can order from their catalog.`
        : `Request sent to ${supplier.name}. You can order once they accept.`
    );
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

export async function respondToRequest(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const accept = req.body.decision === "accept";

  try {
    const partnership = await setPartnershipStatus(
      Number(req.params.partnerId),
      business.id,
      accept ? "active" : "declined"
    );

    if (partnership) {
      publish(partnership.buyer_business_id, "partner", {
        status: partnership.status,
        supplierName: business.name
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
    return res.redirect(`/business/${business.id}/supply`);
  } catch (error) {
    return next(error);
  }
}

export async function disconnectPartner(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    const removed = await deletePartnership(Number(req.params.partnerId), business.id);
    if (removed) {
      const other =
        removed.buyer_business_id === business.id
          ? removed.supplier_business_id
          : removed.buyer_business_id;
      publish(other, "partner", { status: "removed", name: business.name });
    }
    req.flash(removed ? "success" : "error", removed ? "Connection removed." : "Connection not found.");
    return res.redirect(`/business/${business.id}/supply`);
  } catch (error) {
    return next(error);
  }
}

// --- Placing an order ---

export async function showNewOrder(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const user = req.session.user;
    const partners = (await listSuppliersFor(business.id)).filter(
      (p) => p.status === "active"
    );

    if (partners.length === 0) {
      req.flash("error", "Connect to a supplier first, using their code.");
      return res.redirect(`/business/${business.id}/supply`);
    }

    const requested = Number(req.query.supplier);
    const partner =
      partners.find((p) => p.supplier_business_id === requested) || partners[0];

    const supplier = await getTradingBusiness(partner.supplier_business_id);
    const [catalog, history, ownProducts] = await Promise.all([
      supplierCatalog(supplier.id),
      deliveryHistory(business.id, supplier.id),
      listProducts(business.id, user.id)
    ]);

    // The catalog is priced in the supplier's currency; restate it in the
    // buyer's so the order total means one thing on both sides.
    const buyerBase = user.base_currency || user.currency || DEFAULT_CURRENCY;
    const items = catalog.map((product) => ({
      ...product,
      price: Number(convert(product.sale_price, supplier.base_currency, buyerBase).toFixed(2)),
      inStock: Number(product.quantity)
    }));

    const eta = estimateEta({
      leadTimeDays: supplier.lead_time_days,
      samples: history.map((h) => Math.max(0, transitDays({ placed_on: h.placed_on, delivered_at: h.delivered_at }) ?? 0)),
      from: today()
    });

    return res.render("supply-new", {
      title: `${business.name} · New supply order`,
      business,
      partners,
      partner,
      supplier,
      items,
      eta,
      ownProducts,
      showAmount: amountFormatter(user),
      // The running total is added up in the browser, so it needs the same
      // symbol and precision the server would have used.
      currencyInfo:
        CURRENCY_BY_CODE.get(displayCurrencyOf(user)) ||
        { symbol: displayCurrencyOf(user), decimals: 2 }
    });
  } catch (error) {
    return next(error);
  }
}

export async function placeOrder(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const user = req.session.user;
  const supplierId = Number(req.body.supplierId);
  const back = `/business/${business.id}/supply/new?supplier=${supplierId}`;

  try {
    const partnership = await getPartnership(business.id, supplierId);
    if (!partnership || partnership.status !== "active") {
      req.flash("error", "You are not connected to that supplier.");
      return res.redirect(`/business/${business.id}/supply`);
    }

    const supplier = await getTradingBusiness(supplierId);
    const catalog = await supplierCatalog(supplierId);
    const buyerBase = user.base_currency || user.currency || DEFAULT_CURRENCY;

    // Quantities arrive as qty[p<product id>] — the "p" keeps the form parser
    // from reading numeric keys as array indexes and renumbering them.
    const quantities = req.body.qty || {};
    const items = [];

    for (const product of catalog) {
      const quantity = Number.parseFloat(quantities[`p${product.id}`]);
      if (!Number.isFinite(quantity) || quantity <= 0) continue;
      items.push({
        supplierProductId: product.id,
        name: product.name,
        sku: product.sku,
        quantity,
        unitPrice: Number(convert(product.sale_price, supplier.base_currency, buyerBase).toFixed(2))
      });
    }

    // An off-catalog line, priced by the buyer in their display currency.
    const customName = (req.body.customName || "").trim();
    const customQty = Number.parseFloat(req.body.customQuantity);
    const customPrice = Number.parseFloat(req.body.customPrice);
    if (customName && Number.isFinite(customQty) && customQty > 0) {
      items.push({
        name: customName,
        quantity: customQty,
        unitPrice: Number(
          convert(
            Number.isFinite(customPrice) ? customPrice : 0,
            displayCurrencyOf(user),
            buyerBase
          ).toFixed(2)
        )
      });
    }

    if (items.length === 0) {
      req.flash("error", "Add a quantity to at least one item.");
      return res.redirect(back);
    }

    const history = await deliveryHistory(business.id, supplierId);
    const eta = estimateEta({
      leadTimeDays: supplier.lead_time_days,
      samples: history.map((h) =>
        Math.max(0, transitDays({ placed_on: h.placed_on, delivered_at: h.delivered_at }) ?? 0)
      ),
      from: today()
    });

    const order = await createSupplyOrder({
      buyerBusinessId: business.id,
      buyerUserId: user.id,
      supplierBusinessId: supplierId,
      supplierUserId: supplier.user_id,
      currency: buyerBase,
      note: (req.body.note || "").trim() || null,
      expectedOn: eta.date,
      placedOn: today(),
      items
    });

    const units = items.reduce((sum, i) => sum + i.quantity, 0);
    await announce({ ...order, buyer_business_id: business.id, supplier_business_id: supplierId }, {
      businessId: business.id,
      userId: user.id,
      statusChanged: true,
      body:
        `${business.name} placed order #${order.id} — ${items.length} line(s), ` +
        `${units} unit(s). Estimated delivery ${formatDate(eta.date)} (${eta.basis}).`
    });

    req.flash("success", `Order #${order.id} sent to ${supplier.name}.`);
    return res.redirect(`/business/${business.id}/supply/orders/${order.id}`);
  } catch (error) {
    return next(error);
  }
}

// --- The order itself ---

export async function showOrder(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const order = await requireOrder(req, res, business);
    if (!order) return undefined;

    const user = req.session.user;
    const role = roleOn(order, business);
    const [items, messages, history] = await Promise.all([
      listOrderItems(order.id),
      listMessages(order.id),
      deliveryHistory(order.buyer_business_id, order.supplier_business_id)
    ]);

    const eta = estimateEta({
      leadTimeDays: order.supplier_lead_time,
      samples: history
        .filter((h) => h.id !== order.id)
        .map((h) =>
          Math.max(0, transitDays({ placed_on: h.placed_on, delivered_at: h.delivered_at }) ?? 0)
        ),
      from: toISODate(order.placed_on)
    });

    return res.render("supply-order", {
      title: `Supply order #${order.id}`,
      business,
      order,
      role,
      counterparty: role === "buyer" ? order.supplier_name : order.buyer_name,
      items,
      messages,
      steps: timeline(order),
      progress: progressPercent(order),
      eta,
      target: targetDate(order),
      late: isLate(order),
      slip: lateness(order),
      actualDays: transitDays(order),
      meta: statusMeta(order.status),
      defaultPromise: addDays(today(), order.supplier_lead_time || 3),
      showAmount: amountFormatter(user),
      termsDays: PAYMENT_TERMS_DAYS
    });
  } catch (error) {
    return next(error);
  }
}

// Supplier accepts and commits to a delivery date.
export async function confirmOrder(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    const existing = await requireOrder(req, res, business);
    if (!existing) return undefined;

    const back = `/business/${business.id}/supply/orders/${existing.id}`;
    if (roleOn(existing, business) !== "supplier") {
      req.flash("error", "Only the supplier can confirm an order.");
      return res.redirect(back);
    }

    const promisedOn =
      (req.body.promisedOn || "").trim() ||
      addDays(today(), existing.supplier_lead_time || 3);

    const order = await advanceOrder(existing.id, {
      from: ["placed"],
      status: "confirmed",
      stampColumn: "confirmed_at",
      fields: { promised_on: promisedOn }
    });

    if (!order) {
      req.flash("error", "This order can no longer be confirmed.");
      return res.redirect(back);
    }

    await announce(order, {
      businessId: business.id,
      userId: req.session.user.id,
      statusChanged: true,
      body: `${business.name} confirmed the order and committed to deliver by ${formatDate(promisedOn)}.`
    });

    req.flash("success", "Order confirmed.");
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

// Supplier ships: stock leaves their shelves and the sale is invoiced.
export async function shipOrder(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    const existing = await requireOrder(req, res, business);
    if (!existing) return undefined;

    const back = `/business/${business.id}/supply/orders/${existing.id}`;
    if (roleOn(existing, business) !== "supplier") {
      req.flash("error", "Only the supplier can ship an order.");
      return res.redirect(back);
    }

    const tracking = (req.body.tracking || "").trim() || null;
    const order = await shipSupplyOrder(existing.id, tracking);
    if (!order) {
      req.flash("error", "This order can no longer be shipped.");
      return res.redirect(back);
    }

    // Dispatch is the point of sale for the supplier: raise the receivable on
    // their books, converted into their own currency.
    const supplier = await getTradingBusiness(order.supplier_business_id);
    const amount = Number(
      convert(order.total, order.currency, supplier.base_currency).toFixed(2)
    );

    let invoiceNote = "";
    if (amount > 0) {
      const invoice = await createInvoice({
        businessId: order.supplier_business_id,
        userId: order.supplier_user_id,
        customer: existing.buyer_name,
        amount,
        category: "Sales",
        issuedOn: today(),
        dueOn: addDays(today(), PAYMENT_TERMS_DAYS),
        note: `Supply order #${order.id}`
      });
      await linkOrderDocument(order.id, "invoice_id", invoice.id);
      invoiceNote = ` Invoice #${invoice.id} raised, due ${formatDate(invoice.due_on)}.`;
    }

    await announce({ ...existing, ...order }, {
      businessId: business.id,
      userId: req.session.user.id,
      statusChanged: true,
      body:
        `${business.name} shipped the order${tracking ? ` (tracking ${tracking})` : ""}.` +
        `${invoiceNote}`
    });

    req.flash("success", "Order shipped — stock deducted and invoice raised.");
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

// Either side can record that the goods arrived.
export async function markDelivered(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    const existing = await requireOrder(req, res, business);
    if (!existing) return undefined;

    const back = `/business/${business.id}/supply/orders/${existing.id}`;
    const order = await advanceOrder(existing.id, {
      from: ["shipped"],
      status: "delivered",
      stampColumn: "delivered_at"
    });

    if (!order) {
      req.flash("error", "This order is not out for delivery.");
      return res.redirect(back);
    }

    const slip = lateness({ ...existing, ...order });
    const timing =
      slip === null
        ? ""
        : slip > 0
          ? ` ${slip} day(s) later than promised.`
          : slip < 0
            ? ` ${Math.abs(slip)} day(s) ahead of the promised date.`
            : " Exactly on the promised date.";

    await announce({ ...existing, ...order }, {
      businessId: business.id,
      userId: req.session.user.id,
      statusChanged: true,
      body: `${business.name} marked the order delivered.${timing}`
    });

    req.flash("success", "Marked as delivered.");
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

// Buyer receives: goods land in inventory and the bill lands in payables.
export async function receiveOrder(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    const existing = await requireOrder(req, res, business);
    if (!existing) return undefined;

    const back = `/business/${business.id}/supply/orders/${existing.id}`;
    if (roleOn(existing, business) !== "buyer") {
      req.flash("error", "Only the buyer can receive an order into stock.");
      return res.redirect(back);
    }

    const result = await receiveSupplyOrder(existing.id);
    if (!result) {
      req.flash("error", "This order has not shipped yet.");
      return res.redirect(back);
    }

    const { order, items } = result;
    const units = items.reduce((sum, i) => sum + Number(i.quantity), 0);

    let billNote = "";
    if (Number(order.total) > 0) {
      const bill = await createBill({
        businessId: order.buyer_business_id,
        userId: order.buyer_user_id,
        vendor: existing.supplier_name,
        amount: Number(order.total),
        category: "Inventory Purchase",
        issuedOn: today(),
        dueOn: addDays(today(), PAYMENT_TERMS_DAYS),
        note: `Supply order #${order.id}`
      });
      await linkOrderDocument(order.id, "bill_id", bill.id);
      billNote = ` Bill #${bill.id} added to payables, due ${formatDate(bill.due_on)}.`;
    }

    await announce({ ...existing, ...order }, {
      businessId: business.id,
      userId: req.session.user.id,
      statusChanged: true,
      body: `${business.name} received the order — ${units} unit(s) into stock.${billNote}`
    });

    req.flash("success", "Received — stock updated and the bill is in payables.");
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

// Buyer pulls out, or supplier turns the order down.
export async function closeOrder(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    const existing = await requireOrder(req, res, business);
    if (!existing) return undefined;

    const back = `/business/${business.id}/supply/orders/${existing.id}`;
    const role = roleOn(existing, business);
    const declining = role === "supplier";

    const order = await advanceOrder(existing.id, {
      from: ["placed", "confirmed"],
      status: declining ? "declined" : "cancelled",
      stampColumn: "closed_at"
    });

    if (!order) {
      req.flash("error", "An order that has shipped can no longer be stopped.");
      return res.redirect(back);
    }

    const reason = (req.body.reason || "").trim();
    await announce({ ...existing, ...order }, {
      businessId: business.id,
      userId: req.session.user.id,
      statusChanged: true,
      body:
        `${business.name} ${declining ? "declined" : "cancelled"} the order` +
        `${reason ? `: ${reason}` : "."}`
    });

    req.flash("success", declining ? "Order declined." : "Order cancelled.");
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

// --- Live thread ---

export async function postMessage(req, res, next) {
  try {
    const business = await getBusiness(Number(req.params.id), req.session.user.id);
    if (!business) {
      return res.status(404).json({ error: "Business not found." });
    }

    const order = await getOrder(Number(req.params.orderId));
    const party =
      order &&
      (order.buyer_business_id === business.id ||
        order.supplier_business_id === business.id);
    if (!party) {
      return res.status(404).json({ error: "Order not found." });
    }

    const body = (req.body.body || "").trim().slice(0, 1000);
    if (!body) {
      return res.status(400).json({ error: "Write a message first." });
    }

    const message = await announce(order, {
      businessId: business.id,
      userId: req.session.user.id,
      body
    });

    return res.json({
      message: {
        id: message.id,
        kind: message.kind,
        body: message.body,
        businessId: message.business_id,
        businessName: message.business_name,
        userName: message.user_name,
        createdAt: message.created_at
      }
    });
  } catch (error) {
    return next(error);
  }
}

// The live feed every supply chain page listens on.
export async function streamUpdates(req, res, next) {
  try {
    const business = await getBusiness(Number(req.params.id), req.session.user.id);
    if (!business) {
      return res.status(404).end();
    }
    subscribe(business.id, res);
    return undefined;
  } catch (error) {
    return next(error);
  }
}

// --- Reports ---

export async function showSupplyReports(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const user = req.session.user;
    const display = displayCurrencyOf(user);
    const [rawOrders, buyItems, sellItems] = await Promise.all([
      listOrdersFor(business.id, 500),
      listItemsFor(business.id, "buyer"),
      listItemsFor(business.id, "supplier")
    ]);

    const orders = inViewerCurrency(rawOrders, user);
    const outgoing = orders.filter((o) => o.role === "buyer");
    const incoming = orders.filter((o) => o.role === "supplier");

    // Line prices carry their order's currency; restate them the same way.
    const restate = (items) =>
      items.map((item) => ({
        ...item,
        unit_price: convert(item.unit_price, item.currency, display)
      }));

    return res.render("supply-reports", {
      title: `${business.name} · Supply chain reports`,
      business,
      buying: summarizeOrders(outgoing),
      selling: summarizeOrders(incoming),
      supplierCards: partnerScorecards(outgoing, "supplier"),
      buyerCards: partnerScorecards(incoming, "buyer"),
      buyTrend: monthlySeries(outgoing),
      sellTrend: monthlySeries(incoming),
      boughtItems: topItems(restate(buyItems)),
      soldItems: topItems(restate(sellItems)),
      lateOrders: outgoing.filter((o) => isLate(o)),
      outgoingCount: outgoing.length,
      incomingCount: incoming.length,
      money: (amount) => formatCurrency(amount, display)
    });
  } catch (error) {
    return next(error);
  }
}
