// Compute one employee's pay for a period. Monthly employees earn their
// pay_rate; hourly employees earn pay_rate × hours. deduction_rate is the
// percentage withheld for tax and statutory contributions. All money is in
// the business's base currency.
export function computePayslip(employee, hoursOverride) {
  const rate = Number(employee.pay_rate) || 0;
  const hours =
    employee.pay_type === "hourly"
      ? Number(hoursOverride ?? employee.hours) || 0
      : 0;

  const gross = employee.pay_type === "hourly" ? rate * hours : rate;
  const deductions = gross * ((Number(employee.deduction_rate) || 0) / 100);
  const net = gross - deductions;

  return {
    gross: Math.round(gross * 100) / 100,
    deductions: Math.round(deductions * 100) / 100,
    net: Math.round(net * 100) / 100,
    hours
  };
}
