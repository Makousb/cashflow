import { Router } from "express";

import { showLanding } from "../controllers/public.controller.js";
import {
  captureLead,
  showPublicFunnel,
  unsubscribe
} from "../controllers/marketing.controller.js";

const router = Router();

router.get("/", showLanding);

// Reached by people who do not have an account here, so no auth guard.
router.get("/f/:slug", showPublicFunnel);
router.post("/f/:slug", captureLead);
// One click, from the link in a promotional email.
router.get("/unsubscribe/:token", unsubscribe);

export default router;
