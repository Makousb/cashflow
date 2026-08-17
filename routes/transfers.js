import { Router } from "express";

import { addTransfer, removeTransfer } from "../controllers/transfers.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(requireAuth);
router.post("/", addTransfer);
router.post("/:id/delete", removeTransfer);

export default router;
