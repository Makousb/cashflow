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

export default router;
