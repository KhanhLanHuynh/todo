"use strict";

const path = require("path");
const express = require("express");
const bcrypt = require("bcryptjs");
const { createPool, migrate, taskJson, flowJson } = require("./db");
const { generateDueFlows } = require("./generate");
const { setSessionCookie, clearSessionCookie, requireUser } = require("./auth");

const ROOT = path.join(__dirname, "..");
const PRIORITIES = new Set(["high", "medium", "low"]);
const CATEGORIES = new Set(["Work", "Personal", "Health"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

function validEmail(value) {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function userJson(row) {
  return { id: row.id, email: row.email };
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function createApp(pool) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.post("/api/register", asyncRoute(async (req, res) => {
    const email = cleanText(req.body?.email, 254).toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!validEmail(email) || password.length < 8 || password.length > 72) {
      res.status(400).json({ error: "Use a valid email and a password of 8 to 72 characters." });
      return;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    try {
      const result = await pool.query(
        "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email",
        [email, passwordHash]
      );
      setSessionCookie(res, result.rows[0].id);
      res.status(201).json(userJson(result.rows[0]));
    } catch (error) {
      if (error.code === "23505") {
        res.status(409).json({ error: "An account with that email already exists." });
        return;
      }
      throw error;
    }
  }));

  app.post("/api/login", asyncRoute(async (req, res) => {
    const email = cleanText(req.body?.email, 254).toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const result = await pool.query(
      "SELECT id, email, password_hash FROM users WHERE email = $1",
      [email]
    );
    const user = result.rows[0];
    const hash = user ? user.password_hash : DUMMY_HASH;
    const matches = await bcrypt.compare(password, hash);
    if (!user || !matches) {
      res.status(401).json({ error: "Email or password is incorrect." });
      return;
    }
    setSessionCookie(res, user.id);
    res.json(userJson(user));
  }));

  app.post("/api/logout", (req, res) => {
    clearSessionCookie(res);
    res.status(204).end();
  });

  app.get("/api/me", requireUser, asyncRoute(async (req, res) => {
    const result = await pool.query("SELECT id, email FROM users WHERE id = $1", [req.userId]);
    if (!result.rows[0]) {
      clearSessionCookie(res);
      res.status(401).json({ error: "Sign in required" });
      return;
    }
    res.json(userJson(result.rows[0]));
  }));

  app.get("/api/tasks", requireUser, asyncRoute(async (req, res) => {
    const date = req.query.date;
    if (!validDate(date)) {
      res.status(400).json({ error: "Choose a valid day." });
      return;
    }
    await generateDueFlows(pool, req.userId, date);
    const result = await pool.query(
      `SELECT id, title, priority, category, time_label, completed, task_date, sort_order
       FROM tasks
       WHERE user_id = $1 AND task_date = $2
       ORDER BY sort_order ASC, title ASC`,
      [req.userId, date]
    );
    res.json(result.rows.map(taskJson));
  }));

  app.post("/api/tasks/copy-remaining", requireUser, asyncRoute(async (req, res) => {
    const from = req.body?.from;
    const to = req.body?.to;
    if (!validDate(from) || !validDate(to)) {
      res.status(400).json({ error: "Choose a valid day." });
      return;
    }
    if (from === to) {
      res.status(400).json({ error: "Choose two different days." });
      return;
    }
    await generateDueFlows(pool, req.userId, to);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const source = await client.query(
        `SELECT COUNT(*)::int AS total
         FROM tasks
         WHERE user_id = $1 AND task_date = $2 AND completed = false`,
        [req.userId, from]
      );
      const inserted = await client.query(
        `INSERT INTO tasks (user_id, task_date, title, priority, category, time_label, completed, sort_order)
         SELECT $1, $2, src.title, src.priority, src.category, src.time_label, false,
                base.next_order + ROW_NUMBER() OVER (ORDER BY src.sort_order ASC, src.title ASC) - 1
         FROM tasks src
         CROSS JOIN (
           SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
           FROM tasks
           WHERE user_id = $1 AND task_date = $2
         ) base
         WHERE src.user_id = $1
           AND src.task_date = $3
           AND src.completed = false
           AND NOT EXISTS (
             SELECT 1 FROM tasks existing
             WHERE existing.user_id = $1
               AND existing.task_date = $2
               AND existing.completed = false
               AND existing.title = src.title
           )
         RETURNING id, title, priority, category, time_label, completed, task_date, sort_order`,
        [req.userId, to, from]
      );
      await client.query("COMMIT");
      res.json({
        tasks: inserted.rows.map(taskJson),
        skipped: source.rows[0].total - inserted.rows.length
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.post("/api/tasks", requireUser, asyncRoute(async (req, res) => {
    const title = cleanText(req.body?.title, 120);
    const priority = PRIORITIES.has(req.body?.priority) ? req.body.priority : "medium";
    const category = CATEGORIES.has(req.body?.category) ? req.body.category : "Work";
    const time = cleanText(req.body?.time, 20) || "09:00 AM";
    const taskDate = req.body?.taskDate;
    const completed = Boolean(req.body?.completed);
    if (!title || !validDate(taskDate)) {
      res.status(400).json({ error: "A task needs a title and a day." });
      return;
    }
    const orderResult = await pool.query(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM tasks WHERE user_id = $1 AND task_date = $2",
      [req.userId, taskDate]
    );
    const requestedOrder = Number(req.body?.sortOrder);
    const sortOrder = Number.isInteger(requestedOrder) ? requestedOrder : orderResult.rows[0].next_order;
    const result = await pool.query(
      `INSERT INTO tasks (user_id, task_date, title, priority, category, time_label, completed, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, title, priority, category, time_label, completed, task_date, sort_order`,
      [req.userId, taskDate, title, priority, category, time, completed, sortOrder]
    );
    res.status(201).json(taskJson(result.rows[0]));
  }));

  app.patch("/api/tasks/:id", requireUser, asyncRoute(async (req, res) => {
    if (!UUID.test(req.params.id)) {
      res.status(400).json({ error: "Unknown task." });
      return;
    }
    const fields = [];
    const values = [];
    const set = (column, value) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (req.body?.title !== undefined) {
      const title = cleanText(req.body.title, 120);
      if (!title) {
        res.status(400).json({ error: "A task needs a title." });
        return;
      }
      set("title", title);
    }
    if (req.body?.priority !== undefined) {
      if (!PRIORITIES.has(req.body.priority)) {
        res.status(400).json({ error: "Unknown priority." });
        return;
      }
      set("priority", req.body.priority);
    }
    if (req.body?.category !== undefined) {
      if (!CATEGORIES.has(req.body.category)) {
        res.status(400).json({ error: "Unknown category." });
        return;
      }
      set("category", req.body.category);
    }
    if (req.body?.time !== undefined) {
      const time = cleanText(req.body.time, 20);
      if (!time) {
        res.status(400).json({ error: "A task needs a time." });
        return;
      }
      set("time_label", time);
    }
    if (req.body?.completed !== undefined) set("completed", Boolean(req.body.completed));
    if (!fields.length) {
      res.status(400).json({ error: "Nothing to update." });
      return;
    }
    values.push(req.params.id, req.userId);
    const result = await pool.query(
      `UPDATE tasks SET ${fields.join(", ")}
       WHERE id = $${values.length - 1} AND user_id = $${values.length}
       RETURNING id, title, priority, category, time_label, completed, task_date, sort_order`,
      values
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Task not found." });
      return;
    }
    res.json(taskJson(result.rows[0]));
  }));

  app.delete("/api/tasks/:id", requireUser, asyncRoute(async (req, res) => {
    if (!UUID.test(req.params.id)) {
      res.status(400).json({ error: "Unknown task." });
      return;
    }
    const result = await pool.query(
      `DELETE FROM tasks WHERE id = $1 AND user_id = $2
       RETURNING id, title, priority, category, time_label, completed, task_date, sort_order`,
      [req.params.id, req.userId]
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Task not found." });
      return;
    }
    res.json(taskJson(result.rows[0]));
  }));

  app.delete("/api/tasks", requireUser, asyncRoute(async (req, res) => {
    const date = req.query.date;
    if (!validDate(date) || req.query.completed !== "true") {
      res.status(400).json({ error: "Choose a day of completed tasks to clear." });
      return;
    }
    const result = await pool.query(
      `DELETE FROM tasks WHERE user_id = $1 AND task_date = $2 AND completed = true
       RETURNING id, title, priority, category, time_label, completed, task_date, sort_order`,
      [req.userId, date]
    );
    res.json(result.rows.map(taskJson));
  }));

  app.post("/api/tasks/reorder", requireUser, asyncRoute(async (req, res) => {
    const date = req.body?.date;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    if (!validDate(date) || !ids || ids.some((id) => !UUID.test(id))) {
      res.status(400).json({ error: "Task order is invalid." });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT id FROM tasks WHERE user_id = $1 AND task_date = $2",
        [req.userId, date]
      );
      const have = new Set(existing.rows.map((row) => row.id));
      const unique = new Set(ids);
      if (ids.length !== have.size || unique.size !== ids.length || ids.some((id) => !have.has(id))) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Task order does not match this day." });
        return;
      }
      for (let index = 0; index < ids.length; index += 1) {
        await client.query(
          "UPDATE tasks SET sort_order = $1 WHERE id = $2 AND user_id = $3",
          [index, ids[index], req.userId]
        );
      }
      await client.query("COMMIT");
      res.status(204).end();
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }));

  app.get("/api/flows", requireUser, asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT id, title, priority, category, schedule, enabled
       FROM flows WHERE user_id = $1 ORDER BY title ASC`,
      [req.userId]
    );
    res.json(result.rows.map(flowJson));
  }));

  app.post("/api/flows", requireUser, asyncRoute(async (req, res) => {
    const title = cleanText(req.body?.title, 80);
    const priority = PRIORITIES.has(req.body?.priority) ? req.body.priority : "medium";
    const category = CATEGORIES.has(req.body?.category) ? req.body.category : "Work";
    const schedule = cleanText(req.body?.schedule, 80);
    const enabled = req.body?.enabled === undefined ? true : Boolean(req.body.enabled);
    if (!title || !schedule) {
      res.status(400).json({ error: "A flow needs a name and a schedule." });
      return;
    }
    const result = await pool.query(
      `INSERT INTO flows (user_id, title, priority, category, schedule, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, priority, category, schedule, enabled`,
      [req.userId, title, priority, category, schedule, enabled]
    );
    res.status(201).json(flowJson(result.rows[0]));
  }));

  app.patch("/api/flows/:id", requireUser, asyncRoute(async (req, res) => {
    if (!UUID.test(req.params.id)) {
      res.status(400).json({ error: "Unknown flow." });
      return;
    }
    const fields = [];
    const values = [];
    const set = (column, value) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };
    if (req.body?.title !== undefined) {
      const title = cleanText(req.body.title, 80);
      if (!title) {
        res.status(400).json({ error: "A flow needs a name." });
        return;
      }
      set("title", title);
    }
    if (req.body?.priority !== undefined) {
      if (!PRIORITIES.has(req.body.priority)) {
        res.status(400).json({ error: "Unknown priority." });
        return;
      }
      set("priority", req.body.priority);
    }
    if (req.body?.category !== undefined) {
      if (!CATEGORIES.has(req.body.category)) {
        res.status(400).json({ error: "Unknown category." });
        return;
      }
      set("category", req.body.category);
    }
    if (req.body?.schedule !== undefined) {
      const schedule = cleanText(req.body.schedule, 80);
      if (!schedule) {
        res.status(400).json({ error: "A flow needs a schedule." });
        return;
      }
      set("schedule", schedule);
    }
    if (req.body?.enabled !== undefined) set("enabled", Boolean(req.body.enabled));
    if (!fields.length) {
      res.status(400).json({ error: "Nothing to update." });
      return;
    }
    values.push(req.params.id, req.userId);
    const result = await pool.query(
      `UPDATE flows SET ${fields.join(", ")}
       WHERE id = $${values.length - 1} AND user_id = $${values.length}
       RETURNING id, title, priority, category, schedule, enabled`,
      values
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Flow not found." });
      return;
    }
    res.json(flowJson(result.rows[0]));
  }));

  app.delete("/api/flows/:id", requireUser, asyncRoute(async (req, res) => {
    if (!UUID.test(req.params.id)) {
      res.status(400).json({ error: "Unknown flow." });
      return;
    }
    const result = await pool.query(
      `DELETE FROM flows WHERE id = $1 AND user_id = $2
       RETURNING id, title, priority, category, schedule, enabled`,
      [req.params.id, req.userId]
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Flow not found." });
      return;
    }
    res.json(flowJson(result.rows[0]));
  }));

  app.use("/assets", express.static(path.join(ROOT, "assets")));
  app.get("/", (req, res) => {
    res.sendFile(path.join(ROOT, "index.html"));
  });
  app.get("/styles.css", (req, res) => {
    res.sendFile(path.join(ROOT, "styles.css"));
  });
  app.get("/app.js", (req, res) => {
    res.sendFile(path.join(ROOT, "app.js"));
  });

  app.use("/api", (req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  app.use((error, req, res, next) => {
    console.error(error);
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(500).json({ error: "Something went wrong." });
  });

  return app;
}

async function main() {
  if (!process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is required");
  }
  const pool = createPool();
  await migrate(pool);
  const app = createApp(pool);
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Daily Task Tracker listening on ${port}`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = { createApp };
