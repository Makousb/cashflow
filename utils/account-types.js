// The three sides of the app, and what signing up for each one provisions.
//
// The type a person picks decides where they land and what the navigation
// offers. It is a starting point rather than a partition: nothing stops a
// personal account adding a business later, or a shop registering as a
// supplier too.

export const ACCOUNT_TYPES = {
  personal: {
    label: "Personal",
    blurb: "Track your own money — wallets, budgets, goals and loans.",
    icon: "👤",
    home: "/dashboard"
  },
  business: {
    label: "Business",
    blurb: "Run a small business — books, stock, sales, payroll and tax.",
    icon: "🏪",
    home: "/business"
  },
  supplier: {
    label: "Supplier",
    blurb: "Sell to businesses — publish a catalog and fulfil their orders.",
    icon: "🏭",
    home: "/supplier"
  }
};

export function isAccountType(value) {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_TYPES, value);
}

export function homeFor(accountType) {
  return isAccountType(accountType) ? ACCOUNT_TYPES[accountType].home : "/dashboard";
}
