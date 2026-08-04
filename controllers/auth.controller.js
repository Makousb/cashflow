import bcrypt from "bcrypt";

import { createAccount } from "../db/queries/accounts.js";
import { createBusiness } from "../db/queries/business.js";
import { createSupplier } from "../db/queries/suppliers.js";
import { ACCOUNT_TYPES, homeFor, isAccountType } from "../utils/account-types.js";
import { createUser, findUserByEmail } from "../db/queries/users.js";
import {
  CURRENCIES,
  DEFAULT_CURRENCY,
  isSupportedCurrency
} from "../utils/currencies.js";

const SALT_ROUNDS = 10;

export function showRegister(req, res) {
  res.render("auth/register", {
    accountTypes: ACCOUNT_TYPES,
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
  // Which side they are signing up for. Anything unrecognised falls back to
  // personal rather than failing the signup.
  const accountType = isAccountType(req.body.accountType) ? req.body.accountType : "personal";
  const orgName = (req.body.orgName || "").trim().slice(0, 120);

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
    const user = await createUser({ name, email, passwordHash, currency, accountType });

    // Every account gets a cash wallet: even a supplier has personal money, and
    // it means the first transaction always has somewhere to go.
    await createAccount({ userId: user.id, name: "Cash", type: "cash" });

    // Signing up for a side provisions it, so nobody lands on an empty app and
    // has to work out what to create first.
    if (accountType === "business") {
      await createBusiness({
        userId: user.id, name: orgName || `${name}'s business`, industry: null
      });
    } else if (accountType === "supplier") {
      await createSupplier({
        userId: user.id, name: orgName || `${name}'s supply`, industry: null
      });
    }

    req.session.user = user;
    req.flash(
      "success",
      accountType === "supplier"
        ? "Welcome to Cashflow! Add what you sell and share your code with buyers."
        : accountType === "business"
          ? "Welcome to Cashflow! Your business is set up — start with the books."
          : "Welcome to Cashflow! Record your first transaction."
    );
    return res.redirect(homeFor(accountType));
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
      base_currency: user.base_currency,
      account_type: user.account_type
    };
    // Back to whichever side this account is for, rather than always the
    // personal dashboard.
    return res.redirect(homeFor(user.account_type));
  } catch (error) {
    return next(error);
  }
}

export function logout(req, res) {
  req.session.destroy(() => {
    res.redirect("/");
  });
}
