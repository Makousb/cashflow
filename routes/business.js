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
import {
  changeFunnelStatus,
  draftCampaign,
  editCampaign,
  generateFunnel,
  previewAudience,
  removeCampaign,
  removeFunnel,
  sendCampaign,
  showContact,
  showMarketing,
  updateContact
} from "../controllers/marketing.controller.js";
import { askAdvisor, showAdvisor } from "../controllers/advisor.controller.js";
import {
  addAccount,
  // Aliased: the bookkeeping page already exports an addEntry, and a journal
  // entry is a different animal from a line in the cash book.
  addEntry as addJournalEntry,
  closeYear,
  reopenYear,
  runBackfill,
  showEntry,
  showLedger
} from "../controllers/ledger.controller.js";
import {
  addLocation,
  moveStock,
  placeEverything,
  setDefault,
  showLocations
} from "../controllers/warehouse.controller.js";
import {
  addSubsidiary,
  reparent,
  savePlace,
  showGroup
} from "../controllers/group.controller.js";
import {
  addCase,
  addOpportunity,
  changeCaseStatus,
  moveDeal,
  removeDeal,
  replyToCase,
  showCase,
  showCrm
} from "../controllers/crm.controller.js";
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

// General ledger. Declared before the module pages that follow so nothing
// reads "ledger" as one of their ids.
router.get("/:id/ledger", showLedger);
router.get("/:id/ledger/entries/:entryId", showEntry);
router.post("/:id/ledger/entries", addJournalEntry);
router.post("/:id/ledger/accounts", addAccount);
router.post("/:id/ledger/backfill", runBackfill);
router.post("/:id/ledger/close", closeYear);
router.post("/:id/ledger/closes/:closeId/reopen", reopenYear);

// Sales pipeline and support desk
router.get("/:id/crm", showCrm);
router.post("/:id/crm/deals", addOpportunity);
router.post("/:id/crm/deals/:dealId/move", moveDeal);
router.post("/:id/crm/deals/:dealId/delete", removeDeal);
router.get("/:id/crm/cases/:caseId", showCase);
router.post("/:id/crm/cases", addCase);
router.post("/:id/crm/cases/:caseId/reply", replyToCase);
router.post("/:id/crm/cases/:caseId/status", changeCaseStatus);

// Stock locations: where the units actually are
router.get("/:id/locations", showLocations);
router.post("/:id/locations", addLocation);
router.post("/:id/locations/:locationId/default", setDefault);
router.post("/:id/locations/transfers", moveStock);
router.post("/:id/locations/place", placeEverything);

// Group: branches, where each trades, and consolidated figures
router.get("/:id/group", showGroup);
router.post("/:id/group/subsidiaries", addSubsidiary);
router.post("/:id/group/place", savePlace);
router.post("/:id/group/members/:memberId/parent", reparent);

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

// Marketing agent: funnels, captured contacts, promotions
router.get("/:id/marketing", showMarketing);
router.get("/:id/marketing/audience", previewAudience);
router.post("/:id/marketing/funnels", generateFunnel);
router.post("/:id/marketing/funnels/:funnelId/status", changeFunnelStatus);
router.post("/:id/marketing/funnels/:funnelId/delete", removeFunnel);
router.get("/:id/marketing/contacts/:contactId", showContact);
router.post("/:id/marketing/contacts/:contactId", updateContact);
router.post("/:id/marketing/campaigns", draftCampaign);
router.post("/:id/marketing/campaigns/:campaignId", editCampaign);
router.post("/:id/marketing/campaigns/:campaignId/send", sendCampaign);
router.post("/:id/marketing/campaigns/:campaignId/delete", removeCampaign);

// Business advisor
router.get("/:id/advisor", showAdvisor);
router.post("/:id/advisor/ask", askAdvisor);

export default router;
