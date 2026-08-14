import { pool } from "../index.js";

export async function listGoals(userId) {
  const { rows } = await pool.query(
    "SELECT * FROM goals WHERE user_id = $1 ORDER BY created_at",
    [userId]
  );
  return rows;
}

export async function createGoal({ userId, name, targetAmount, targetDate }) {
  const { rows } = await pool.query(
    `INSERT INTO goals (user_id, name, target_amount, target_date)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [userId, name, targetAmount, targetDate]
  );
  return rows[0];
}

export async function getGoal(id, userId) {
  const { rows } = await pool.query(
    "SELECT * FROM goals WHERE id = $1 AND user_id = $2",
    [id, userId]
  );
  return rows[0] || null;
}

export async function addToGoal(id, userId, amount) {
  const { rows } = await pool.query(
    `UPDATE goals
     SET saved_amount = saved_amount + $1
     WHERE id = $2 AND user_id = $3
     RETURNING *`,
    [amount, id, userId]
  );
  return rows[0] || null;
}
