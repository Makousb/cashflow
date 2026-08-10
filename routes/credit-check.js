import { Router } from "express";

import {
  showCheck,
  showRequestForm,
  showRequestStatus,
  submitRequest
} from "../controllers/credit-check.controller.js";

const router = Router();

// Reached by a lender who has no account here, so no auth guard. A token is the
// whole of the authority to view anything, and the controller checks it is still
// good before a thing is gathered.
//
// The request routes come first: "/:token" would otherwise swallow "request".
router.get("/request", showRequestForm);
router.post("/request", submitRequest);
router.get("/request/:token", showRequestStatus);
router.get("/:token", showCheck);

export default router;
