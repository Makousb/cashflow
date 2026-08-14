import crypto from "crypto";
import path from "path";

import multer from "multer";
import { Router } from "express";

import {
  confirmReceipt,
  serveReceiptImage,
  showReceiptsPage,
  showReviewPage,
  uploadReceipt,
  UPLOADS_DIR
} from "../controllers/receipts.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${req.session.user.id}-${crypto.randomUUID()}${ext}`);
  }
});

// A photo of a paper receipt is never a vector graphic, so SVG is refused
// along with everything non-image — not only because it is the wrong kind of
// file here, but because an SVG can carry a <script>, and this one is served
// straight back to its own uploader (see serveReceiptImage) behind a link
// that opens it directly rather than inside an <img>. mimetype is a header
// the uploader wrote, not a fact about the bytes, so this narrows what gets
// past the filter; it is not proof of what is actually in the file.
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ALLOWED_TYPES.has(file.mimetype));
  }
});

const router = Router();

router.use(requireAuth);
router.get("/", showReceiptsPage);
router.post("/upload", upload.single("receipt"), uploadReceipt);
router.get("/:id/review", showReviewPage);
router.post("/:id/confirm", confirmReceipt);
router.get("/:id/image", serveReceiptImage);

export default router;
