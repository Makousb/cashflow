import { Router } from "express";

import {
  addBusiness,
  addEntry,
  removeBusiness,
  removeEntry,
  showBusinessDashboard,
  showBusinessHub
} from "../controllers/business.controller.js";
import {
  addProduct,
  createReorder,
  orderProduct,
  receiveOrder,
  removeOrder,
  removeProduct,
  restockProduct,
  showInventory
} from "../controllers/inventory.controller.js";
import {
  addEmployee,
  removeEmployee,
  removePayRun,
  runPayroll,
  showPayroll
} from "../controllers/payroll.controller.js";
import {
  removeProvision,
  setAside,
  showTax,
  updateSettings
} from "../controllers/tax.controller.js";
import {
  removeBudget,
  setBudget,
  showPlanning
} from "../controllers/planning.controller.js";
import {
  addBill,
  addInvoice,
  payBill,
  payInvoice,
  removeBill,
  removeInvoice,
  showBills,
  showInvoices,
  showStatements
} from "../controllers/accounting.controller.js";
import {
  recordSale,
  removeSale,
  showSales
} from "../controllers/sales.controller.js";
import {
  closeOrder,
  confirmOrder,
  connectSupplier,
  disconnectPartner,
  markDelivered,
  placeOrder,
  postMessage,
  receiveOrder as receiveSupplyOrder,
  respondToRequest,
  saveSupplyProfile,
  shipOrder,
  showNewOrder,
  showOrder,
  showSupplyChain,
  showSupplyReports,
  streamUpdates
} from "../controllers/supply.controller.js";
import {
  applyCategory,
  applyProvision,
  runReview,
  showAccountant,
  saveReviewEmail,
  showLooseEntries,
  toggleAutoReview
} from "../controllers/accountant.controller.js";
import { askAdvisor, showAdvisor } from "../controllers/advisor.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(requireAuth);
router.get("/", showBusinessHub);
router.post("/", addBusiness);
router.get("/:id", showBusinessDashboard);
router.post("/:id/entries", addEntry);
router.post("/:id/entries/:entryId/delete", removeEntry);
router.post("/:id/delete", removeBusiness);

// Inventory management + ordering
router.get("/:id/inventory", showInventory);
router.post("/:id/inventory/products", addProduct);
router.post("/:id/inventory/products/:pid/restock", restockProduct);
router.post("/:id/inventory/products/:pid/delete", removeProduct);
router.post("/:id/inventory/reorder", createReorder);
router.post("/:id/inventory/order", orderProduct);
router.post("/:id/inventory/orders/:oid/receive", receiveOrder);
router.post("/:id/inventory/orders/:oid/delete", removeOrder);

// Sales (takes stock off the shelf and books the money)
router.get("/:id/sales", showSales);
router.post("/:id/sales", recordSale);
router.post("/:id/sales/:saleId/void", removeSale);

// Payroll
router.get("/:id/payroll", showPayroll);
router.post("/:id/payroll/employees", addEmployee);
router.post("/:id/payroll/employees/:eid/delete", removeEmployee);
router.post("/:id/payroll/run", runPayroll);
router.post("/:id/payroll/runs/:rid/delete", removePayRun);

// Tax preparation
router.get("/:id/tax", showTax);
router.post("/:id/tax/settings", updateSettings);
router.post("/:id/tax/provisions", setAside);
router.post("/:id/tax/provisions/:provId/delete", removeProvision);

// Budgeting & planning
router.get("/:id/planning", showPlanning);
router.post("/:id/planning/budgets", setBudget);
router.post("/:id/planning/budgets/:budgetId/delete", removeBudget);

// Financial statements
router.get("/:id/statements", showStatements);

// Accounts receivable (invoices)
router.get("/:id/invoices", showInvoices);
router.post("/:id/invoices", addInvoice);
router.post("/:id/invoices/:invId/pay", payInvoice);
router.post("/:id/invoices/:invId/delete", removeInvoice);

// Accounts payable (bills)
router.get("/:id/bills", showBills);
router.post("/:id/bills", addBill);
router.post("/:id/bills/:billId/pay", payBill);
router.post("/:id/bills/:billId/delete", removeBill);

// Supply chain: trading with other businesses, live
router.get("/:id/supply", showSupplyChain);
router.get("/:id/supply/stream", streamUpdates);
router.get("/:id/supply/reports", showSupplyReports);
router.post("/:id/supply/profile", saveSupplyProfile);
router.post("/:id/supply/partners", connectSupplier);
router.post("/:id/supply/partners/:partnerId/respond", respondToRequest);
router.post("/:id/supply/partners/:partnerId/delete", disconnectPartner);
router.get("/:id/supply/new", showNewOrder);
router.post("/:id/supply/orders", placeOrder);
router.get("/:id/supply/orders/:orderId", showOrder);
router.post("/:id/supply/orders/:orderId/confirm", confirmOrder);
router.post("/:id/supply/orders/:orderId/ship", shipOrder);
router.post("/:id/supply/orders/:orderId/deliver", markDelivered);
router.post("/:id/supply/orders/:orderId/receive", receiveSupplyOrder);
router.post("/:id/supply/orders/:orderId/close", closeOrder);
router.post("/:id/supply/orders/:orderId/messages", postMessage);

// Accounting agent: reviews the books, computes the tax position, proposes fixes
router.get("/:id/accountant", showAccountant);
router.post("/:id/accountant/run", runReview);
router.post("/:id/accountant/schedule", toggleAutoReview);
router.post("/:id/accountant/notify", saveReviewEmail);
router.get("/:id/accountant/entries", showLooseEntries);
router.post("/:id/accountant/provision", applyProvision);
router.post("/:id/accountant/entries/:txId", applyCategory);

// Business advisor
router.get("/:id/advisor", showAdvisor);
router.post("/:id/advisor/ask", askAdvisor);

export default router;
