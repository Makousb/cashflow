import {
  addBusinessTransaction,
  getBusiness
} from "../db/queries/business.js";
import {
  attachPayRunTransaction,
  claimPayRun,
  createEmployee,
  deleteEmployee,
  deletePayRun,
  listEmployees,
  listPayRuns,
  listPayslips,
  releasePayRun
} from "../db/queries/payroll.js";
import { toBase } from "../services/fx.js";
import { payrollEntry } from "../utils/ledger.js";
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

    // Claim the period before any money moves. Whoever gets the row runs the
    // payroll; anybody else — the second click, the reloaded tab — is told it
    // is already done rather than quietly paying everyone twice.
    const run = await claimPayRun({
      businessId: business.id,
      userId,
      period,
      runOn: today(),
      payslips
    });

    if (!run) {
      req.flash(
        "error",
        `${period} has already been run. Delete that pay run first if you need to do it again.`
      );
      return res.redirect(`/business/${business.id}/payroll`);
    }

    // The employer's cost is the gross; post it to the business ledger.
    //
    // The journal says more than the cash book can. The whole gross is the cost,
    // but only the net actually leaves — what was withheld is owed to somebody
    // else and has not been remitted yet, so it sits as a liability. Booking the
    // gross straight against cash would claim the deductions were already paid
    // over, which is exactly the money a business gets caught short on.
    const deductionTotal = payslips.reduce((sum, p) => sum + p.deductions, 0);
    try {
      const transaction = await addBusinessTransaction({
        businessId: business.id,
        userId,
        kind: "expense",
        amount: grossTotal,
        category: "Payroll",
        note: `Payroll: ${period}`,
        occurredOn: today(),
        entry: payrollEntry({
          gross: grossTotal,
          deductions: deductionTotal,
          memo: `Payroll: ${period}`
        })
      });
      await attachPayRunTransaction(run.id, transaction.id);
    } catch (error) {
      // The claim was taken on the promise of posting the cost. Posting can
      // still refuse — a closed year, most likely — and a period left claimed
      // for a payroll that never happened would block the real one.
      await releasePayRun(run.id);
      throw error;
    }

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
