import { addMonths, monthKey, monthsBetween, toISODate } from "./dates.js";

// Interest is modelled as an annual APR compounded monthly on the running
// balance. All amounts are in the loan's base currency. Figures are estimates
// for planning — not a lender's exact statement.

// Current balance, total paid, and interest accrued to date for one loan.
export function loanMetrics(loan, payments, todayIso) {
  const monthlyRate = Number(loan.apr) / 100 / 12;
  const startIso = toISODate(loan.start_date);

  const paidByMonth = new Map();
  let totalPaid = 0;
  for (const payment of payments) {
    const amount = Number(payment.amount);
    totalPaid += amount;
    const key = monthKey(toISODate(payment.paid_on));
    paidByMonth.set(key, (paidByMonth.get(key) || 0) + amount);
  }

  let balance = Number(loan.principal);
  let interestAccrued = 0;
  for (const key of monthsBetween(startIso, todayIso)) {
    const interest = balance * monthlyRate;
    balance += interest;
    interestAccrued += interest;
    balance -= paidByMonth.get(key) || 0;
    if (balance < 0) {
      balance = 0;
    }
  }

  const denominator = totalPaid + balance;
  const progressPct = denominator > 0 ? (totalPaid / denominator) * 100 : 100;

  return {
    balance,
    totalPaid,
    interestAccrued,
    monthlyInterest: balance * monthlyRate,
    progressPct: Math.max(0, Math.min(100, progressPct)),
    isPaidOff: balance <= 0.005
  };
}

// Months and total interest to clear `balance` paying `monthlyPayment` each
// month. Returns neverPaysOff when the payment can't cover the interest.
export function projectPayoff(balance, apr, monthlyPayment, todayIso) {
  const monthlyRate = Number(apr) / 100 / 12;
  let remaining = Number(balance);
  const payment = Number(monthlyPayment);

  if (remaining <= 0) {
    return { months: 0, totalInterest: 0, payoffDate: todayIso, neverPaysOff: false };
  }
  if (payment <= remaining * monthlyRate + 0.005) {
    return { neverPaysOff: true, months: null, totalInterest: null, payoffDate: null };
  }

  let months = 0;
  let totalInterest = 0;
  while (remaining > 0 && months < 600) {
    const interest = remaining * monthlyRate;
    remaining += interest;
    totalInterest += interest;
    remaining -= Math.min(payment, remaining);
    months += 1;
  }

  // Clamped, so a loan being cleared from the 31st comes off the books on the
  // last day of the target month rather than spilling into the one after it.
  // addMonths reads the start date as a calendar day, not as UTC midnight.
  const payoff = addMonths(todayIso, months);

  return { months, totalInterest, payoffDate: toISODate(payoff), neverPaysOff: false };
}
