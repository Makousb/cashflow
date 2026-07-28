import {
  addBusinessTransaction,
  getBusiness
} from "../db/queries/business.js";
import {
  createEmployee,
  createPayRun,
  deleteEmployee,
  deletePayRun,
  listEmployees,
  listPayRuns,
  listPayslips
} from "../db/queries/payroll.js";
import { toBase } from "../services/fx.js";
import { monthLabel, today } from "../utils/dates.js";
import { computePayslip } from "../utils/payroll.js";

async function requireBusiness(req, res) {
  const business = await getBusiness(Number(req.params.id), req.session.user.id);
  if (!business) {
    req.flash("error", "Business not found.");
    res.redirect("/business");
    return null;
  }
  return business;
}

export async function showPayroll(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const userId = req.session.user.id;
    const [employees, runs] = await Promise.all([
      listEmployees(business.id, userId),
      listPayRuns(business.id, userId)
    ]);

    const active = employees.filter((e) => e.active);
    const monthlyCost = active.reduce(
      (sum, e) => sum + computePayslip(e).gross,
      0
    );

    // Payslip breakdown for the most recent run.
    const latestPayslips = runs.length ? await listPayslips(runs[0].id) : [];

    return res.render("payroll", {
      title: `${business.name} · Payroll`,
      business,
      employees,
      activeCount: active.length,
      monthlyCost,
      runs,
      latestRun: runs[0] || null,
      latestPayslips,
      defaultPeriod: monthLabel()
    });
  } catch (error) {
    return next(error);
  }
}

export async function addEmployee(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const name = (req.body.name || "").trim();
  if (!name) {
    req.flash("error", "Give the employee a name.");
    return res.redirect(`/business/${business.id}/payroll`);
  }

  const payType = req.body.payType === "hourly" ? "hourly" : "monthly";
  const rate = Number.parseFloat(req.body.payRate);
  const hours = Number.parseFloat(req.body.hours);
  let deduction = Number.parseFloat(req.body.deductionRate);
  deduction = Number.isFinite(deduction) ? Math.min(Math.max(deduction, 0), 100) : 0;

  try {
    await createEmployee({
      businessId: business.id,
      userId: req.session.user.id,
      name,
      role: (req.body.role || "").trim() || null,
      payType,
      // pay_rate is money → base; hours and deduction% are not money.
      payRate: toBase(req.session.user, Number.isFinite(rate) && rate >= 0 ? rate : 0),
      hours: payType === "hourly" && Number.isFinite(hours) && hours >= 0 ? hours : 0,
      deductionRate: deduction
    });
    req.flash("success", "Employee added.");
    return res.redirect(`/business/${business.id}/payroll`);
  } catch (error) {
    return next(error);
  }
}

export async function removeEmployee(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    await deleteEmployee(Number(req.params.eid), req.session.user.id);
    req.flash("success", "Employee removed.");
    return res.redirect(`/business/${business.id}/payroll`);
  } catch (error) {
    return next(error);
  }
}

export async function runPayroll(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const period = (req.body.period || "").trim() || monthLabel();

  try {
    const userId = req.session.user.id;
    const active = (await listEmployees(business.id, userId)).filter((e) => e.active);

    if (active.length === 0) {
      req.flash("error", "Add an active employee before running payroll.");
      return res.redirect(`/business/${business.id}/payroll`);
    }

    const payslips = active.map((emp) => {
      // Hourly employees can have their hours overridden for this run.
      const override = req.body[`hours_${emp.id}`];
      const slip = computePayslip(emp, override !== undefined && override !== ""
        ? Number.parseFloat(override)
        : undefined);
      return {
        employeeId: emp.id,
        name: emp.name,
        gross: slip.gross,
        deductions: slip.deductions,
        net: slip.net
      };
    });

    const grossTotal = payslips.reduce((sum, p) => sum + p.gross, 0);

    if (grossTotal <= 0) {
      req.flash("error", "This run comes to zero — check pay rates and hours.");
      return res.redirect(`/business/${business.id}/payroll`);
    }

    // The employer's cost is the gross; post it to the business ledger.
    const transaction = await addBusinessTransaction({
      businessId: business.id,
      userId,
      kind: "expense",
      amount: grossTotal,
      category: "Payroll",
      note: `Payroll: ${period}`,
      occurredOn: today()
    });

    await createPayRun({
      businessId: business.id,
      userId,
      transactionId: transaction.id,
      period,
      runOn: today(),
      payslips
    });

    req.flash("success", `Payroll run for ${period} — ${payslips.length} employee(s) paid.`);
    return res.redirect(`/business/${business.id}/payroll`);
  } catch (error) {
    return next(error);
  }
}

export async function removePayRun(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    await deletePayRun(Number(req.params.rid), req.session.user.id);
    req.flash("success", "Pay run deleted and its ledger cost reversed.");
    return res.redirect(`/business/${business.id}/payroll`);
  } catch (error) {
    return next(error);
  }
}
