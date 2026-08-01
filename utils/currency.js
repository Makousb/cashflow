import { CURRENCY_BY_CODE, DEFAULT_CURRENCY } from "./currencies.js";

const numberFormatters = new Map();

function numberFormatter(decimals) {
  if (!numberFormatters.has(decimals)) {
    numberFormatters.set(
      decimals,
      new Intl.NumberFormat("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      })
    );
  }
  return numberFormatters.get(decimals);
}

export function formatCurrency(amount, currency = DEFAULT_CURRENCY) {
  const info = CURRENCY_BY_CODE.get(currency) || { symbol: currency, decimals: 2 };
  const value = Number(amount) || 0;
  // The minus sign belongs in front of the symbol — "$-50.00" reads as a typo.
  const sign = value < 0 ? "-" : "";
  const number = numberFormatter(info.decimals).format(Math.abs(value));
  // Letter symbols ("KSh", "R") get a space; glyphs ("$", "€") hug the number.
  const separator = /[A-Za-z]$/.test(info.symbol) ? " " : "";
  return `${sign}${info.symbol}${separator}${number}`;
}
