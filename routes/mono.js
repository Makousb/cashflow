import { Router } from "express";

import {
  finishConnect,
  handleWebhook,
  startConnect
} from "../controllers/mono.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

// Mono calls this one directly — no session, no same-app Origin, and its own
// mono-webhook-secret header is the authentication, so it stays outside
// requireAuth.
router.post("/webhook", handleWebhook);

router.post("/connect", requireAuth, startConnect);
router.get("/redirect", requireAuth, finishConnect);

export default router;
