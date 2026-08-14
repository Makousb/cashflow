import { Router } from "express";

import {
  addTransaction,
  editTransaction,
  listTransactionsPage,
  removeTransaction
} from "../controllers/transactions.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(requireAuth);
router.get("/", listTransactionsPage);
router.post("/", addTransaction);
router.post("/:id/edit", editTransaction);
router.post("/:id/delete", removeTransaction);

export default router;
