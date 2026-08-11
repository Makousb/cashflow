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
  approve,
  deny,
  showChecksPage,
  stopCheck
} from "../controllers/credit-check.controller.js";
import {
  askAgent,
  raiseLimit,
  redeemPoints,
  runNow,
  saveSettings,
  showAgent
} from "../controllers/card-agent.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(requireAuth);
router.get("/", showCreditPage);
router.get("/report", showCreditReport);
// Declared before "/:id" so "checks" is not read as a facility id.
router.get("/checks", showChecksPage);
router.post("/checks", addCheck);
router.post("/checks/:id/stop", stopCheck);
router.post("/checks/requests/:id/approve", approve);
router.post("/checks/requests/:id/deny", deny);
// The card agent, likewise declared ahead of "/:id".
router.get("/agent", showAgent);
router.post("/agent/run", runNow);
router.post("/agent/settings", saveSettings);
router.post("/agent/ask", askAgent);
router.post("/agent/:id/redeem", redeemPoints);
router.post("/agent/:id/limit", raiseLimit);
router.post("/apply", apply);
router.post("/installments/:id/pay", payInstallment);
router.post("/:id/charges", chargeCard);
router.post("/:id/pay", payCard);
router.post("/:id/close", closeCard);

export default router;
