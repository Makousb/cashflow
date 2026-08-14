// The three sides of the app, and what signing up for each one provisions.
//
// The type a person picks decides what is provisioned and where they land,
// both at signup and on every login afterwards. It is a starting point rather
// than a partition: nothing stops a personal account adding a business later,
// or a shop registering as a supplier too — which is why the navigation offers
// all three sides to everyone rather than being cut down to the type chosen
// here. (It said otherwise for a while; the navigation has never read this.)

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
