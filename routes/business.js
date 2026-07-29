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

// Business advisor
router.get("/:id/advisor", showAdvisor);
router.post("/:id/advisor/ask", askAdvisor);

export default router;
