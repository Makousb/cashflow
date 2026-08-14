import { Router } from "express";

import {
  login,
  logout,
  register,
  showLogin,
  showRegister
} from "../controllers/auth.controller.js";
import { redirectIfAuthed } from "../middlewares/auth.middleware.js";
import { limitLogin, limitRegister } from "../middlewares/rate-limit.middleware.js";

const router = Router();

router.get("/register", redirectIfAuthed, showRegister);
router.post("/register", redirectIfAuthed, limitRegister, register);
router.get("/login", redirectIfAuthed, showLogin);
router.post("/login", redirectIfAuthed, limitLogin, login);
router.post("/logout", logout);

export default router;
