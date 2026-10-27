"use strict";

const { scheduleMatches, timeOf } = require("./schedule");

function isoDate(value) {
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function generateDueFlows(pool, userId, date) {
  const todayResult = await pool.query("SELECT CURRENT_DATE::text AS today");
  const today = isoDate(todayResult.rows[0].today);
  if (date < today) return;

  const flows = await pool.query(
    `SELECT id, title, priority, category, schedule,
            (created_at AT TIME ZONE 'UTC')::date AS created_date
     FROM flows
     WHERE user_id = $1 AND enabled = true`,
    [userId]
  );
  const due = flows.rows.filter((flow) => scheduleMatches(flow.schedule, isoDate(flow.created_date), date));
  if (!due.length) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const flow of due) {
      const claimed = await client.query(
        `INSERT INTO flow_occurrences (flow_id, task_date)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING flow_id`,
        [flow.id, date]
      );
      if (!claimed.rows[0]) continue;
      const order = await client.query(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM tasks WHERE user_id = $1 AND task_date = $2",
        [userId, date]
      );
      await client.query(
        `INSERT INTO tasks (user_id, task_date, title, priority, category, time_label, completed, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, false, $7)`,
        [userId, date, flow.title, flow.priority, flow.category, timeOf(flow.schedule), order.rows[0].next_order]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { generateDueFlows };
