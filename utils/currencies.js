// Currencies the app can display in. Amounts are never converted — this only
// controls the symbol and formatting, so switching currency relabels the same
// numbers. East-African currencies are listed first since Cashflow's roots
// (M-Pesa, matatus, local vendors) are there.
export const CURRENCIES = [
  { code: "KES", name: "Kenyan Shilling", symbol: "KSh", decimals: 2 },
  { code: "UGX", name: "Ugandan Shilling", symbol: "USh", decimals: 0 },
  { code: "TZS", name: "Tanzanian Shilling", symbol: "TSh", decimals: 2 },
  { code: "RWF", name: "Rwandan Franc", symbol: "FRw", decimals: 0 },
  { code: "USD", name: "US Dollar", symbol: "$", decimals: 2 },
  { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
  { code: "GBP", name: "British Pound", symbol: "£", decimals: 2 },
  { code: "NGN", name: "Nigerian Naira", symbol: "₦", decimals: 2 },
  { code: "ZAR", name: "South African Rand", symbol: "R", decimals: 2 },
  { code: "INR", name: "Indian Rupee", symbol: "₹", decimals: 2 },
  { code: "AED", name: "UAE Dirham", symbol: "AED", decimals: 2 },
  { code: "CNY", name: "Chinese Yuan", symbol: "CN¥", decimals: 2 },
  { code: "JPY", name: "Japanese Yen", symbol: "¥", decimals: 0 },
  { code: "CAD", name: "Canadian Dollar", symbol: "C$", decimals: 2 },
  { code: "AUD", name: "Australian Dollar", symbol: "A$", decimals: 2 }
];

export const DEFAULT_CURRENCY = "KES";

export const CURRENCY_BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

export function isSupportedCurrency(code) {
  return CURRENCY_BY_CODE.has(code);
}
