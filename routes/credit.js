import { Router } from "express";

import {
  apply,
  closeCard,
  payInstallment,
  showCreditPage
} from "../controllers/credit.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(requireAuth);
router.get("/", showCreditPage);
router.post("/apply", apply);
router.post("/installments/:id/pay", payInstallment);
router.post("/:id/close", closeCard);

export default router;
