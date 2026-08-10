import { Router } from "express";

import {
  apply,
  chargeCard,
  closeCard,
  payCard,
  payInstallment,
  showCreditPage,
  showCreditReport
} from "../controllers/credit.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(requireAuth);
router.get("/", showCreditPage);
router.get("/report", showCreditReport);
router.post("/apply", apply);
router.post("/installments/:id/pay", payInstallment);
router.post("/:id/charges", chargeCard);
router.post("/:id/pay", payCard);
router.post("/:id/close", closeCard);

export default router;
