import { pool } from "../index.js";

// Storage for the pipeline and the support desk. What a deal is worth to a
// forecast and whether a case is late are decided in utils/crm.js; this only
// keeps the rows and writes the contact's timeline as things happen to them.

// Every deal, with the contact's name where there is one. Left join, because a
// deal without a contact is ordinary rather than broken.
export async function listOpportunities(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT o.id, o.contact_id, o.name, o.value::float, o.stage, o.probability,
            o.note,
            to_char(o.expected_close, 'YYYY-MM-DD') AS expected_close,
            to_char(o.updated_on, 'YYYY-MM-DD') AS updated_on,
            to_char(o.created_on, 'YYYY-MM-DD') AS created_on,
            to_char(o.closed_on, 'YYYY-MM-DD') AS closed_on,
            c.name AS contact_name, c.email AS contact_email
     FROM opportunities o
     LEFT JOIN contacts c ON c.id = o.contact_id
     WHERE o.business_id = $1 AND o.user_id = $2
     ORDER BY o.updated_on DESC, o.id DESC`,
    [businessId, userId]
  );
  return rows;
}

export async function getOpportunity(id, businessId, userId) {
  const { rows } = await pool.query(
    `SELECT *, o.value::float AS value FROM opportunities o
     WHERE id = $1 AND business_id = $2 AND user_id = $3`,
    [id, businessId, userId]
  );
  return rows[0] || null;
}

export async function createOpportunity({
  businessId, userId, contactId = null, name, value = 0,
  stage = "lead", probability = null, expectedClose = null, note = null
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO opportunities
         (business_id, user_id, contact_id, name, value, stage, probability,
          expected_close, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [businessId, userId, contactId, name, value, stage, probability, expectedClose, note]
    );
    const opportunity = rows[0];

    // The contact's timeline is the point of having contacts. A deal opened
    // against somebody belongs on it.
    if (contactId) {
      await client.query(
        `INSERT INTO contact_events (contact_id, kind, detail) VALUES ($1, 'deal', $2)`,
        [contactId, `Deal opened: ${name}`]
      );
    }

    await client.query("COMMIT");
    return opportunity;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Moving a deal. updated_on is touched here and nowhere else, which is what
// makes "nothing has moved on this for 40 days" a fact rather than a guess.
// closed_on is set when it leaves the open stages and cleared if it comes back,
// because deals do come back.
export async function moveOpportunity({ id, businessId, userId, stage, closed }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE opportunities
       SET stage = $4,
           updated_on = CURRENT_DATE,
           closed_on = CASE WHEN $5 THEN CURRENT_DATE ELSE NULL END
       WHERE id = $1 AND business_id = $2 AND user_id = $3
       RETURNING *`,
      [id, businessId, userId, stage, closed]
    );
    const moved = rows[0];
    if (!moved) {
      await client.query("ROLLBACK");
      return null;
    }

    if (moved.contact_id) {
      await client.query(
        `INSERT INTO contact_events (contact_id, kind, detail) VALUES ($1, 'deal', $2)`,
        [moved.contact_id, `Deal "${moved.name}" moved to ${stage}`]
      );
    }

    await client.query("COMMIT");
    return moved;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteOpportunity(id, businessId, userId) {
  const { rowCount } = await pool.query(
    "DELETE FROM opportunities WHERE id = $1 AND business_id = $2 AND user_id = $3",
    [id, businessId, userId]
  );
  return rowCount > 0;
}

// --- Support ---

export async function listCases(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT s.id, s.contact_id, s.subject, s.reporter, s.status, s.priority,
            s.created_at, s.resolved_at,
            c.name AS contact_name, c.email AS contact_email,
            COUNT(m.id)::int AS reply_count
     FROM support_cases s
     LEFT JOIN contacts c ON c.id = s.contact_id
     LEFT JOIN case_messages m ON m.case_id = s.id
     WHERE s.business_id = $1 AND s.user_id = $2
     GROUP BY s.id, c.name, c.email
     ORDER BY s.created_at DESC`,
    [businessId, userId]
  );
  return rows;
}

export async function getCase(id, businessId, userId) {
  const { rows } = await pool.query(
    `SELECT s.*, c.name AS contact_name, c.email AS contact_email
     FROM support_cases s
     LEFT JOIN contacts c ON c.id = s.contact_id
     WHERE s.id = $1 AND s.business_id = $2 AND s.user_id = $3`,
    [id, businessId, userId]
  );
  if (rows.length === 0) return null;

  const { rows: messages } = await pool.query(
    `SELECT id, author, body, created_at FROM case_messages
     WHERE case_id = $1 ORDER BY id`,
    [id]
  );
  return { ...rows[0], messages };
}

// Raising a case takes the first message with it — a case with no description
// is a subject line and a shrug, and the two belong in one transaction.
export async function createCase({
  businessId, userId, contactId = null, subject, reporter = null,
  priority = "normal", body = null
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO support_cases
         (business_id, user_id, contact_id, subject, reporter, priority)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [businessId, userId, contactId, subject, reporter, priority]
    );
    const supportCase = rows[0];

    if (body) {
      await client.query(
        `INSERT INTO case_messages (case_id, user_id, author, body)
         VALUES ($1, $2, 'customer', $3)`,
        [supportCase.id, userId, body]
      );
    }

    if (contactId) {
      await client.query(
        `INSERT INTO contact_events (contact_id, kind, detail) VALUES ($1, 'case', $2)`,
        [contactId, `Case raised: ${subject}`]
      );
    }

    await client.query("COMMIT");
    return supportCase;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function addCaseMessage({ caseId, businessId, userId, author, body }) {
  // Scoped through the case so a message cannot be attached to somebody else's.
  const { rows } = await pool.query(
    `INSERT INTO case_messages (case_id, user_id, author, body)
     SELECT $1, $3, $4, $5
     FROM support_cases WHERE id = $1 AND business_id = $2 AND user_id = $3
     RETURNING *`,
    [caseId, businessId, userId, author, body]
  );
  return rows[0] || null;
}

export async function setCaseStatus({ id, businessId, userId, status }) {
  const { rows } = await pool.query(
    `UPDATE support_cases
     SET status = $4,
         resolved_at = CASE WHEN $4 IN ('resolved', 'closed') THEN NOW() ELSE NULL END
     WHERE id = $1 AND business_id = $2 AND user_id = $3
     RETURNING *`,
    [id, businessId, userId, status]
  );
  return rows[0] || null;
}

// The contacts a deal or a case can be attached to. Only what the pickers need.
export async function pickableContacts(businessId, userId) {
  const { rows } = await pool.query(
    `SELECT id, name, email FROM contacts
     WHERE business_id = $1 AND user_id = $2
     ORDER BY COALESCE(name, email)`,
    [businessId, userId]
  );
  return rows;
}
