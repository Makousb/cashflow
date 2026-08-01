import bcrypt from "bcrypt";

import { createAccount } from "../db/queries/accounts.js";
import { createUser, findUserByEmail } from "../db/queries/users.js";
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  isSupportedCurrency
} from "../utils/currencies.js";

const SALT_ROUNDS = 10;

export function showRegister(req, res) {
  res.render("auth/register", {
    title: "Create account",
    currencies: CURRENCIES,
    defaultCurrency: DEFAULT_CURRENCY
  });
}

export function showLogin(req, res) {
  res.render("auth/login", { title: "Log in" });
}

export async function register(req, res, next) {
  if (!res.locals.dbReady) {
    req.flash("error", "The database is not configured yet — see the README.");
    return res.redirect("/auth/register");
  }

  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  const requested = (req.body.currency || "").trim().toUpperCase();
  const currency = isSupportedCurrency(requested) ? requested : DEFAULT_CURRENCY;

  if (!name || !email || password.length < 8) {
    req.flash(
      "error",
      "Name, email, and a password of at least 8 characters are required."
    );
    return res.redirect("/auth/register");
  }

  try {
    if (await findUserByEmail(email)) {
      req.flash("error", "An account with that email already exists.");
      return res.redirect("/auth/register");
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await createUser({ name, email, passwordHash, currency });

    // Every user starts with a cash wallet so the first transaction has a home.
    await createAccount({ userId: user.id, name: "Cash", type: "cash" });

    req.session.user = user;
    req.flash("success", "Welcome to Cashflow! Record your first transaction.");
    return res.redirect("/dashboard");
  } catch (error) {
    return next(error);
  }
}

export async function login(req, res, next) {
  if (!res.locals.dbReady) {
    req.flash("error", "The database is not configured yet — see the README.");
    return res.redirect("/auth/login");
  }

  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";

  try {
    const user = await findUserByEmail(email);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      req.flash("error", "Invalid email or password.");
      return res.redirect("/auth/login");
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      currency: user.currency,
      base_currency: user.base_currency
    };
    return res.redirect("/dashboard");
  } catch (error) {
    return next(error);
  }
}

export function logout(req, res) {
  req.session.destroy(() => {
    res.redirect("/");
  });
}
