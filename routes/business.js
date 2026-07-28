import { Router } from "express";

import {
  addBusiness,
  addEntry,
  removeBusiness,
  removeEntry,
  showBusinessDashboard,
  showBusinessHub
} from "../controllers/business.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

router.use(requireAuth);
router.get("/", showBusinessHub);
router.post("/", addBusiness);
router.get("/:id", showBusinessDashboard);
router.post("/:id/entries", addEntry);
router.post("/:id/entries/:entryId/delete", removeEntry);
router.post("/:id/delete", removeBusiness);

export default router;
