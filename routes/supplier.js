import { Router } from "express";

import {
  addProduct,
  confirmOrder,
  declineOrder,
  markDelivered,
  shipOrder,
  addSupplier,
  markPaid,
  removeProduct,
  respondToRequest,
  restockProduct,
  saveProfile,
  showSupplier,
  showSupplierHub
} from "../controllers/supplier.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(requireAuth);
router.get("/", showSupplierHub);
router.post("/", addSupplier);
router.get("/:id", showSupplier);
router.post("/:id/profile", saveProfile);
router.post("/:id/catalog", addProduct);
router.post("/:id/catalog/:productId/restock", restockProduct);
router.post("/:id/catalog/:productId/delete", removeProduct);
router.post("/:id/requests/:partnerId/respond", respondToRequest);
router.post("/:id/orders/:orderId/confirm", confirmOrder);
router.post("/:id/orders/:orderId/ship", shipOrder);
router.post("/:id/orders/:orderId/deliver", markDelivered);
router.post("/:id/orders/:orderId/decline", declineOrder);
router.post("/:id/orders/:orderId/paid", markPaid);

export default router;
