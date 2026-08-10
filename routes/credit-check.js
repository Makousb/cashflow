import { Router } from "express";

import { showCheck } from "../controllers/credit-check.controller.js";

const router = Router();

// Reached by a lender who has no account here, so no auth guard. The token in
// the path is the whole of the authority to view, and the controller checks it
// is still good before anything is gathered.
router.get("/:token", showCheck);

export default router;
