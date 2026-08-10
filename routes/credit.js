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
import {
  addCheck,
  showChecksPage,
  stopCheck
} from "../controllers/credit-check.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(requireAuth);
router.get("/", showCreditPage);
router.get("/report", showCreditReport);
// Declared before "/:id" so "checks" is not read as a facility id.
router.get("/checks", showChecksPage);
router.post("/checks", addCheck);
router.post("/checks/:id/stop", stopCheck);
router.post("/apply", apply);
router.post("/installments/:id/pay", payInstallment);
router.post("/:id/charges", chargeCard);
router.post("/:id/pay", payCard);
router.post("/:id/close", closeCard);

export default router;
