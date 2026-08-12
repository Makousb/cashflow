import {
  addCaseMessage,
  createCase,
  createOpportunity,
  deleteOpportunity,
  getCase,
  listCases,
  listOpportunities,
  moveOpportunity,
  pickableContacts,
  setCaseStatus
} from "../db/queries/crm.js";
import { getBusiness } from "../db/queries/business.js";
import { toBase } from "../services/fx.js";
import {
  CASE_PRIORITIES,
  CASE_STATUSES,
  PIPELINE_STAGES,
  STAGE_KEYS,
  caseBoard,
  isOpen,
  isPriority,
  isStage,
  isStatus,
  needsAttention,
  pipeline
} from "../utils/crm.js";
import { today } from "../utils/dates.js";

async function requireBusiness(req, res) {
  const business = await getBusiness(Number(req.params.id), req.session.user.id);
  if (!business) {
    req.flash("error", "Business not found.");
    res.redirect("/business");
    return null;
  }
  return business;
}

export async function showCrm(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const userId = req.session.user.id;
    const [opportunities, cases, contacts] = await Promise.all([
      listOpportunities(business.id, userId),
      listCases(business.id, userId),
      pickableContacts(business.id, userId)
    ]);

    return res.render("crm", {
      title: `${business.name} · Sales & support`,
      business,
      contacts,
      funnel: pipeline(opportunities),
      attention: needsAttention(opportunities, today()),
      board: caseBoard(cases),
      stages: PIPELINE_STAGES,
      stageKeys: STAGE_KEYS,
      priorities: CASE_PRIORITIES,
      statuses: CASE_STATUSES,
      today: today()
    });
  } catch (error) {
    return next(error);
  }
}

export async function addOpportunity(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/crm`;
  const name = (req.body.name || "").trim().slice(0, 160);
  const value = Number.parseFloat(req.body.value);

  if (!name || !Number.isFinite(value) || value < 0) {
    req.flash("error", "A deal needs a name and a value.");
    return res.redirect(back);
  }

  try {
    // The probability is optional, and left null so the stage decides — an
    // empty box means "use the usual odds", not "zero chance".
    const odds = req.body.probability === "" || req.body.probability == null
      ? null
      : Math.min(Math.max(Number.parseInt(req.body.probability, 10) || 0, 0), 100);

    // Checked rather than trusted: the contact must be one of this business's.
    const contacts = await pickableContacts(business.id, req.session.user.id);
    const wanted = req.body.contactId ? Number(req.body.contactId) : null;
    const contactId = contacts.some((c) => c.id === wanted) ? wanted : null;

    await createOpportunity({
      businessId: business.id,
      userId: req.session.user.id,
      contactId,
      name,
      value: toBase(req.session.user, value),
      stage: isStage(req.body.stage) ? req.body.stage : "lead",
      probability: odds,
      expectedClose: req.body.expectedClose || null,
      note: (req.body.note || "").trim().slice(0, 500) || null
    });

    req.flash("success", `"${name}" added to the pipeline.`);
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

export async function moveDeal(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/crm`;
  const stage = req.body.stage;

  if (!isStage(stage)) {
    req.flash("error", "That is not a stage.");
    return res.redirect(back);
  }

  try {
    const moved = await moveOpportunity({
      id: Number(req.params.dealId),
      businessId: business.id,
      userId: req.session.user.id,
      stage,
      closed: !isOpen(stage)
    });

    if (!moved) {
      req.flash("error", "That deal is not here.");
      return res.redirect(back);
    }

    req.flash(
      "success",
      stage === "won"
        ? `"${moved.name}" marked won. Raise an invoice for it when you are ready.`
        : `"${moved.name}" moved to ${PIPELINE_STAGES[stage].label.toLowerCase()}.`
    );
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

export async function removeDeal(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  try {
    await deleteOpportunity(Number(req.params.dealId), business.id, req.session.user.id);
    req.flash("success", "Deal deleted.");
    return res.redirect(`/business/${business.id}/crm`);
  } catch (error) {
    return next(error);
  }
}

// --- Support ---

export async function addCase(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/crm`;
  const subject = (req.body.subject || "").trim().slice(0, 200);

  if (!subject) {
    req.flash("error", "A case needs a subject.");
    return res.redirect(back);
  }

  try {
    const contacts = await pickableContacts(business.id, req.session.user.id);
    const wanted = req.body.contactId ? Number(req.body.contactId) : null;
    const contactId = contacts.some((c) => c.id === wanted) ? wanted : null;

    const supportCase = await createCase({
      businessId: business.id,
      userId: req.session.user.id,
      contactId,
      subject,
      // Somebody with no contact row still has a name worth recording.
      reporter: contactId ? null : (req.body.reporter || "").trim().slice(0, 120) || null,
      priority: isPriority(req.body.priority) ? req.body.priority : "normal",
      body: (req.body.body || "").trim().slice(0, 4000) || null
    });

    req.flash("success", "Case raised.");
    return res.redirect(`/business/${business.id}/crm/cases/${supportCase.id}`);
  } catch (error) {
    return next(error);
  }
}

export async function showCase(req, res, next) {
  try {
    const business = await requireBusiness(req, res);
    if (!business) return undefined;

    const supportCase = await getCase(
      Number(req.params.caseId), business.id, req.session.user.id
    );
    if (!supportCase) {
      req.flash("error", "That case is not here.");
      return res.redirect(`/business/${business.id}/crm`);
    }

    return res.render("crm-case", {
      title: `${business.name} · Case #${supportCase.id}`,
      business,
      supportCase,
      board: caseBoard([supportCase]),
      priorities: CASE_PRIORITIES,
      statuses: CASE_STATUSES
    });
  } catch (error) {
    return next(error);
  }
}

export async function replyToCase(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/crm/cases/${req.params.caseId}`;
  const body = (req.body.body || "").trim().slice(0, 4000);

  if (!body) {
    req.flash("error", "Write something before sending it.");
    return res.redirect(back);
  }

  try {
    const added = await addCaseMessage({
      caseId: Number(req.params.caseId),
      businessId: business.id,
      userId: req.session.user.id,
      author: req.body.author === "customer" ? "customer" : "us",
      body
    });

    if (!added) {
      req.flash("error", "That case is not here.");
      return res.redirect(`/business/${business.id}/crm`);
    }

    req.flash("success", "Added to the thread.");
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}

export async function changeCaseStatus(req, res, next) {
  const business = await requireBusiness(req, res);
  if (!business) return undefined;

  const back = `/business/${business.id}/crm/cases/${req.params.caseId}`;

  if (!isStatus(req.body.status)) {
    req.flash("error", "That is not a status.");
    return res.redirect(back);
  }

  try {
    const updated = await setCaseStatus({
      id: Number(req.params.caseId),
      businessId: business.id,
      userId: req.session.user.id,
      status: req.body.status
    });

    if (!updated) {
      req.flash("error", "That case is not here.");
      return res.redirect(`/business/${business.id}/crm`);
    }

    req.flash("success", `Case marked ${CASE_STATUSES[req.body.status].label.toLowerCase()}.`);
    return res.redirect(back);
  } catch (error) {
    return next(error);
  }
}
