// The categories a business books against. These live outside the controllers
// because four of them need the list, and one of those is the accounting agent
// — which the business dashboard in turn calls into. Keeping the data here is
// what stops that becoming an import cycle.

export const INCOME_CATEGORIES = ["Sales", "Services", "Interest", "Other Income"];
// "Inventory Purchase" replaced "Cost of Goods" when the income statement moved
// to accrual: buying stock is not a cost until the stock sells. Entries already
// filed under the old name still read correctly (see utils/statements.js).
export const EXPENSE_CATEGORIES = [
  "Inventory Purchase",
  "Rent",
  "Utilities",
  "Payroll",
  "Supplies",
  "Marketing",
  "Transport",
  "Fees",
  "Taxes",
  "Other"
];
