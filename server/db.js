"use strict";

const { Pool } = require("pg");

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_date DATE NOT NULL,
  title TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('high', 'medium', 'low')),
  category TEXT NOT NULL CHECK (category IN ('Work', 'Personal', 'Health')),
  time_label TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS tasks_user_date_idx ON tasks (user_id, task_date, sort_order);

CREATE TABLE IF NOT EXISTS flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Work', 'Personal', 'Health')),
  schedule TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS flows_user_idx ON flows (user_id);

ALTER TABLE flows ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS flow_occurrences (
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  task_date DATE NOT NULL,
  PRIMARY KEY (flow_id, task_date)
);
`;

function sslOption(connectionString) {
  if (process.env.PGSSLMODE === "disable") return false;
  if (/localhost|127\.0\.0\.1/.test(connectionString)) return false;
  return { rejectUnauthorized: false };
}

function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const { types } = require("pg");
  // DATE comes back as YYYY-MM-DD so a day does not shift across time zones.
  types.setTypeParser(1082, (value) => value);
  return new Pool({
    connectionString,
    ssl: sslOption(connectionString)
  });
}

async function migrate(pool) {
  await pool.query(SCHEMA);
}

function taskJson(row) {
  return {
    id: row.id,
    title: row.title,
    priority: row.priority,
    category: row.category,
    time: row.time_label,
    completed: row.completed,
    taskDate: row.task_date,
    sortOrder: row.sort_order
  };
}

function flowJson(row) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    schedule: row.schedule,
    enabled: row.enabled
  };
}

module.exports = { createPool, migrate, taskJson, flowJson };
