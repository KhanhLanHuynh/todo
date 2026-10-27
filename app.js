"use strict";

const ICONS = {
  check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5 9.2 17 19 7" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  dots: `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/></svg>`,
  clock: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v4.5l2.5 1.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  zap: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
  edit: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m13.5 6.5 3 3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  trash: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M8 7l1 13h6l1-13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`
};

const state = {
  user: null,
  tasks: [],
  flows: [],
  selectedDate: "",
  authMode: "login",
  filter: "all",
  search: "",
  priorities: [],
  categories: [],
  menuTaskId: null,
  renamingId: null
};

let loadToken = 0;

let undoFn = null;
let toastTimer = null;
let cancelRename = false;
let returnToMaster = false;

const $ = (id) => document.getElementById(id);

function todayIso() {
  return isoDate(new Date());
}

function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIso(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function shiftDate(iso, days) {
  const date = parseIso(iso);
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

function isToday(iso) {
  return iso === todayIso();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !options.quiet) showAuth();
    const error = new Error(data?.error || "Something went wrong");
    error.status = response.status;
    throw error;
  }
  return data;
}

function showAuth() {
  state.user = null;
  $("app-shell").hidden = true;
  $("auth-screen").hidden = false;
  renderAuth();
}

function renderAuth() {
  const register = state.authMode === "register";
  $("auth-title").textContent = register ? "Create account" : "Sign in";
  $("auth-copy").textContent = register
    ? "A new board starts empty. Each day keeps its own tasks."
    : "Your tasks stay on your account, one day at a time.";
  $("auth-form").querySelector("button[type=submit]").textContent = register ? "Create account" : "Sign in";
  $("auth-switch").textContent = register ? "Already have an account? Sign in" : "Create an account";
  $("auth-form").querySelector("[name=password]").autocomplete = register ? "new-password" : "current-password";
}

function renderDateChrome() {
  const selected = parseIso(state.selectedDate);
  $("today-date").textContent = selected.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  }).toUpperCase();
  $("date-input").value = state.selectedDate;
  const today = isToday(state.selectedDate);
  const weekday = selected.toLocaleDateString("en-US", { weekday: "long" });
  $("focus-title").textContent = today ? "Today's Focus" : `${weekday}'s Focus`;
  $("back-today").hidden = today;
}

async function loadTasks() {
  const token = ++loadToken;
  const date = state.selectedDate;
  const tasks = await api(`/api/tasks?date=${date}`);
  if (token !== loadToken || date !== state.selectedDate) return;
  state.tasks = tasks;
  state.menuTaskId = null;
  state.renamingId = null;
  renderTasks();
  renderStats();
}

async function loadFlows() {
  state.flows = await api("/api/flows");
  renderFlows();
}

async function enterApp(user) {
  state.user = user;
  state.selectedDate = state.selectedDate || todayIso();
  $("account-email").textContent = user.email;
  state.tasks = [];
  state.flows = [];
  renderDateChrome();
  renderStats();
  renderTasks();
  renderFlows();
  $("auth-screen").hidden = true;
  $("app-shell").hidden = false;
  await Promise.all([loadTasks(), loadFlows()]);
}

async function setSelectedDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || iso === state.selectedDate) return;
  const previous = state.selectedDate;
  state.selectedDate = iso;
  renderDateChrome();
  try {
    await loadTasks();
  } catch (error) {
    state.selectedDate = previous;
    renderDateChrome();
    toast(error.message);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function stats(tasks) {
  const total = tasks.length;
  const done = tasks.filter((task) => task.completed).length;
  const remaining = total - done;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return { total, done, remaining, pct };
}

function minutesOf(label) {
  const match = String(label).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const mins = parseInt(match[2], 10);
  const ap = match[3].toUpperCase();
  if (ap === "PM" && hours !== 12) hours += 12;
  if (ap === "AM" && hours === 12) hours = 0;
  return hours * 60 + mins;
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

function compareByPriorityThenTime(a, b, timeOfItem) {
  const byPriority = (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3);
  if (byPriority) return byPriority;
  const aMinutes = minutesOf(timeOfItem(a));
  const bMinutes = minutesOf(timeOfItem(b));
  if (aMinutes === null || bMinutes === null) {
    if (aMinutes === bMinutes) return String(a.title).localeCompare(String(b.title));
    return aMinutes === null ? 1 : -1;
  }
  if (aMinutes !== bMinutes) return aMinutes - bMinutes;
  return String(a.title).localeCompare(String(b.title));
}

function sortedFlows() {
  return state.flows.slice().sort((a, b) => compareByPriorityThenTime(a, b, (flow) => flow.schedule));
}

function formatNow() {
  const now = new Date();
  let hours = now.getHours();
  const mins = String(now.getMinutes()).padStart(2, "0");
  const ap = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${String(hours).padStart(2, "0")}:${mins} ${ap}`;
}

function formatTimeValue(value) {
  const [hourText, minuteText] = String(value || "08:00").split(":");
  let hours = parseInt(hourText, 10);
  if (Number.isNaN(hours)) hours = 8;
  const ap = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `${hours}:${minuteText || "00"} ${ap}`;
}

const REPEAT_OPTIONS = ["Daily", "Weekdays", "Weekly", "Bi-weekly", "Monthly"];
const CATEGORY_OPTIONS = ["Work", "Personal", "Health"];
const PRIORITY_OPTIONS = [["high", "High"], ["medium", "Medium"], ["low", "Low"]];

function flowPriority(flow) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, flow?.priority) ? flow.priority : "medium";
}

function timeInputValue(label) {
  const mins = minutesOf(label);
  if (mins === null) return "08:00";
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

function parseSchedule(schedule) {
  const repeatPart = String(schedule || "").split("•")[0].trim();
  const repeats = REPEAT_OPTIONS.find((item) => item.toLowerCase() === repeatPart.toLowerCase()) || "Daily";
  return { repeats, timeValue: timeInputValue(schedule) };
}

function flowBadge(flow) {
  const priority = flowPriority(flow);
  return `<span class="badge ${escapeHtml(priority)}">${escapeHtml(priority)}</span>`;
}

function visibleTasks() {
  const query = state.search.trim().toLowerCase();
  return state.tasks.filter((task) => {
    if (state.filter === "remaining" && task.completed) return false;
    if (state.filter === "completed" && !task.completed) return false;
    if (query && !task.title.toLowerCase().includes(query)) return false;
    if (state.priorities.length && !state.priorities.includes(task.priority)) return false;
    if (state.categories.length && !state.categories.includes(task.category)) return false;
    return true;
  }).sort((a, b) => compareByPriorityThenTime(a, b, (task) => task.time));
}

function progressCopy(done) {
  if (done === 0) return "You've cleared 0 objectives so far.";
  if (done === 1) return "You've cleared 1 objective so far.";
  return `You've cleared ${done} objectives so far.`;
}

function renderStats() {
  const { total, done, remaining, pct } = stats(state.tasks);
  const pill = $("remaining-pill");
  pill.textContent = `${remaining} REMAINING`;
  pill.classList.toggle("clear", total > 0 && remaining === 0);
  $("progress-copy").textContent = progressCopy(done);
  $("progress-pct").textContent = `${pct}%`;
  $("progress-fill").style.width = `${pct}%`;
  $("progress-fill").parentElement.setAttribute("aria-valuenow", String(pct));
  $("bell-dot").hidden = remaining === 0;
}

function renderFilterState() {
  $("filter-btn").classList.toggle("on", state.priorities.length > 0 || state.categories.length > 0);
}

function taskMenu(task) {
  if (state.menuTaskId !== task.id) return "";
  const priorityButton = (value, label) =>
    `<button type="button" data-action="priority" data-value="${value}" class="${task.priority === value ? "active" : ""}">${label}</button>`;
  const categoryButton = (value) =>
    `<button type="button" data-action="category" data-value="${value}" class="${task.category === value ? "active" : ""}">${value}</button>`;
  return `
    <div class="menu">
      <button type="button" data-action="toggle">${task.completed ? "Mark as remaining" : "Mark complete"}</button>
      <div class="menu-label">Priority</div>
      <div class="menu-row">
        ${priorityButton("high", "High")}
        ${priorityButton("medium", "Medium")}
        ${priorityButton("low", "Low")}
      </div>
      <div class="menu-label">Category</div>
      <div class="menu-row">
        ${categoryButton("Work")}
        ${categoryButton("Personal")}
        ${categoryButton("Health")}
      </div>
      <button type="button" data-action="rename">Rename</button>
      <button type="button" data-action="delete" class="danger">Delete</button>
    </div>
  `;
}

function renderTasks() {
  const list = $("task-list");
  const tasks = visibleTasks();
  if (!tasks.length) {
    const hint = state.tasks.length ? "No tasks match this view." : "No tasks on this day yet. Add the first goal below.";
    list.innerHTML = `<li class="empty">${hint}</li>`;
    return;
  }

  list.innerHTML = tasks.map((task) => {
    const title = state.renamingId === task.id
      ? `<input class="rename-input" value="${escapeHtml(task.title)}" aria-label="Rename task">`
      : `<span class="task-title${task.completed ? " done" : ""}">${escapeHtml(task.title)}</span>`;
    return `
      <li class="task${task.completed ? " done" : ""}" data-id="${escapeHtml(task.id)}">
        <button type="button" class="check" aria-pressed="${task.completed}" aria-label="${task.completed ? "Mark remaining" : "Mark complete"}">${task.completed ? ICONS.check : ""}</button>
        <div class="task-main">
          <div class="task-title-row">
            ${title}
            <span class="badge ${escapeHtml(task.priority)}">${escapeHtml(task.priority)}</span>
          </div>
          <div class="task-meta">
            <span class="cat"><i class="dot-cat ${escapeHtml(task.category.toLowerCase())}"></i>${escapeHtml(task.category)}</span>
            <span class="time">${ICONS.clock} ${escapeHtml(task.time)}</span>
          </div>
        </div>
        <button type="button" class="more" aria-label="Task actions" aria-expanded="${state.menuTaskId === task.id}">${ICONS.dots}</button>
        ${taskMenu(task)}
      </li>
    `;
  }).join("");

  if (state.renamingId) {
    const input = list.querySelector(".rename-input");
    if (input) {
      input.focus();
      input.select();
    }
  }
}

function renderFlows() {
  const list = $("flow-list");
  const flows = sortedFlows();
  if (!flows.length) {
    list.innerHTML = `<li class="empty">No recurring flows yet.</li>`;
    return;
  }
  list.innerHTML = flows.map((flow) => `
    <li class="flow">
      <span class="flow-icon">${ICONS.zap}</span>
      <div>
        <div class="flow-title">
          ${escapeHtml(flow.title)}
          ${flowBadge(flow)}
          <span class="chip ${escapeHtml(flow.category.toLowerCase())}">${escapeHtml(flow.category)}</span>
        </div>
        <div class="flow-schedule">${ICONS.clock} ${escapeHtml(flow.schedule)}</div>
      </div>
      <div class="autogen">
        <span>Auto-gen</span>
        <button type="button" class="switch${flow.enabled ? " on" : ""}" data-flow-toggle="${escapeHtml(flow.id)}" aria-pressed="${flow.enabled}" aria-label="Auto-generate ${escapeHtml(flow.title)}"></button>
      </div>
      <div class="flow-actions">
        <button type="button" class="edit" data-flow-edit="${escapeHtml(flow.id)}" aria-label="Edit ${escapeHtml(flow.title)}">${ICONS.edit}</button>
        <button type="button" class="trash" data-flow-delete="${escapeHtml(flow.id)}" aria-label="Remove ${escapeHtml(flow.title)}">${ICONS.trash}</button>
      </div>
    </li>
  `).join("");
}

function renderNotifs() {
  const open = state.tasks.filter((task) => !task.completed);
  const list = $("notif-list");
  if (!open.length) {
    const when = isToday(state.selectedDate) ? "today" : "this day";
    list.innerHTML = `<p class="empty-note">You're clear for ${when}.</p>`;
    return;
  }
  list.innerHTML = open.map((task) => `
    <button type="button" class="notif-item" data-focus-task="${escapeHtml(task.id)}">
      ${escapeHtml(task.title)}
      <small>${escapeHtml(task.time)} · ${escapeHtml(task.category)}</small>
    </button>
  `).join("");
}

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll(".tab").forEach((tab) => {
    const on = tab.dataset.filter === filter;
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", String(on));
  });
  renderTasks();
}

function toast(message, onUndo) {
  const el = $("toast");
  $("toast-text").textContent = message;
  $("toast-undo").hidden = !onUndo;
  undoFn = onUndo || null;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
    undoFn = null;
  }, 3200);
}

function refresh() {
  renderTasks();
  renderFlows();
  renderStats();
}

async function patchTask(id, patch) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  const previous = { ...task };
  Object.assign(task, patch);
  state.menuTaskId = null;
  renderTasks();
  renderStats();
  try {
    const saved = await api(`/api/tasks/${id}`, { method: "PATCH", body: patch });
    Object.assign(task, saved);
    renderTasks();
    renderStats();
  } catch (error) {
    Object.assign(task, previous);
    renderTasks();
    renderStats();
    toast(error.message);
  }
}

function toggleTask(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  patchTask(id, { completed: !task.completed });
}

async function deleteTask(id) {
  const index = state.tasks.findIndex((item) => item.id === id);
  if (index < 0) return;
  const removed = state.tasks[index];
  state.menuTaskId = null;
  state.tasks.splice(index, 1);
  refresh();
  try {
    await api(`/api/tasks/${id}`, { method: "DELETE" });
  } catch (error) {
    state.tasks.splice(index, 0, removed);
    refresh();
    toast(error.message);
    return;
  }
  toast("Task deleted", async () => {
    try {
      const restored = await api("/api/tasks", {
        method: "POST",
        body: {
          title: removed.title,
          priority: removed.priority,
          category: removed.category,
          time: removed.time,
          completed: removed.completed,
          taskDate: removed.taskDate,
          sortOrder: removed.sortOrder
        }
      });
      if (restored.taskDate === state.selectedDate) {
        state.tasks.splice(Math.min(index, state.tasks.length), 0, restored);
        refresh();
      }
    } catch (error) {
      toast(error.message);
    }
  });
}

async function saveRename(id, value) {
  if (state.renamingId !== id) return;
  state.renamingId = null;
  const title = value.trim();
  const task = state.tasks.find((item) => item.id === id);
  if (!task || !title || task.title === title) {
    renderTasks();
    return;
  }
  await patchTask(id, { title });
  if (state.tasks.some((item) => item.id === id && item.title === title)) toast("Task renamed");
}

function handleAction(id, el) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  const action = el.dataset.action;
  if (action === "toggle") {
    toggleTask(id);
    return;
  }
  if (action === "delete") {
    deleteTask(id);
    return;
  }
  if (action === "rename") {
    state.menuTaskId = null;
    state.renamingId = id;
    renderTasks();
    return;
  }
  if (action === "priority") patchTask(id, { priority: el.dataset.value });
  if (action === "category") patchTask(id, { category: el.dataset.value });
}

function positionMenu(id) {
  const row = document.querySelector(`.task[data-id="${CSS.escape(id)}"]`);
  const menu = row && row.querySelector(".menu");
  if (!menu) return;
  const rect = menu.getBoundingClientRect();
  if (rect.bottom > window.innerHeight - 12) menu.classList.add("up");
}

async function toggleFlow(id) {
  const flow = state.flows.find((item) => item.id === id);
  if (!flow) return;
  const next = !flow.enabled;
  flow.enabled = next;
  renderFlows();
  document.querySelectorAll(`[data-flow-toggle="${CSS.escape(id)}"]`).forEach((button) => {
    button.classList.toggle("on", next);
    button.setAttribute("aria-pressed", String(next));
  });
  try {
    const saved = await api(`/api/flows/${id}`, { method: "PATCH", body: { enabled: next } });
    Object.assign(flow, saved);
    toast(saved.enabled ? `${saved.title} will auto-generate` : `${saved.title} paused`);
  } catch (error) {
    flow.enabled = !next;
    renderFlows();
    toast(error.message);
  }
}

async function deleteFlow(id) {
  const index = state.flows.findIndex((item) => item.id === id);
  if (index < 0) return;
  const removed = state.flows[index];
  state.flows.splice(index, 1);
  renderFlows();
  if (!$("modal-back").hidden && $("modal-title").textContent === "Master list") openMaster();
  try {
    await api(`/api/flows/${id}`, { method: "DELETE" });
  } catch (error) {
    state.flows.splice(index, 0, removed);
    renderFlows();
    toast(error.message);
    return;
  }
  toast("Recurring flow removed", async () => {
    try {
      const restored = await api("/api/flows", {
        method: "POST",
        body: {
          title: removed.title,
          priority: removed.priority,
          category: removed.category,
          schedule: removed.schedule,
          enabled: removed.enabled
        }
      });
      state.flows.push(restored);
      renderFlows();
      if (!$("modal-back").hidden && $("modal-title").textContent === "Master list") openMaster();
    } catch (error) {
      toast(error.message);
    }
  });
}

function closePopovers() {
  [
    ["bell-btn", "notif-pop"],
    ["avatar-btn", "avatar-pop"],
    ["filter-btn", "filter-pop"]
  ].forEach(([buttonId, popId]) => {
    $(popId).hidden = true;
    $(buttonId).setAttribute("aria-expanded", "false");
  });
}

function openPopover(buttonId, popId, onOpen) {
  const button = $(buttonId);
  const pop = $(popId);
  const willOpen = pop.hidden;
  closePopovers();
  if (state.menuTaskId) {
    state.menuTaskId = null;
    renderTasks();
  }
  pop.hidden = !willOpen;
  button.setAttribute("aria-expanded", String(!pop.hidden));
  if (!pop.hidden && onOpen) onOpen();
}

function closeModal() {
  $("modal-back").hidden = true;
  document.body.classList.remove("modal-open");
}

function openModal(title, bodyHtml) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = bodyHtml;
  $("modal-back").hidden = false;
  document.body.classList.add("modal-open");
  const field = $("modal-body").querySelector("input, select, button");
  (field || $("modal-close")).focus();
}

function selectOptions(options, selected) {
  return options.map(([value, label]) => {
    const text = label || value;
    return `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(text)}</option>`;
  }).join("");
}

function openFlowForm(flow, options = {}) {
  returnToMaster = Boolean(options.returnToMaster);
  const editing = Boolean(flow);
  const parsed = parseSchedule(flow && flow.schedule);
  const category = CATEGORY_OPTIONS.includes(flow && flow.category) ? flow.category : "Work";
  const priority = flowPriority(flow);
  openModal(editing ? "Edit recurring flow" : "Create recurring flow", `
    <form id="flow-form" class="form"${editing ? ` data-id="${escapeHtml(flow.id)}"` : ""}>
      <label>Name
        <input name="title" required maxlength="80" placeholder="e.g. Evening shutdown" value="${escapeHtml(editing ? flow.title : "")}">
      </label>
      <div class="form-row">
        <label>Category
          <select name="category">
            ${selectOptions(CATEGORY_OPTIONS.map((value) => [value]), category)}
          </select>
        </label>
        <label>Priority
          <select name="priority">
            ${selectOptions(PRIORITY_OPTIONS, priority)}
          </select>
        </label>
      </div>
      <div class="form-row">
        <label>Repeats
          <select name="repeats">
            ${selectOptions(REPEAT_OPTIONS.map((value) => [value]), parsed.repeats)}
          </select>
        </label>
        <label>Time
          <input type="time" name="time" value="${escapeHtml(parsed.timeValue)}">
        </label>
      </div>
      <button class="btn-primary" type="submit">${editing ? "Save changes" : "Save flow"}</button>
    </form>
  `);
}

function openCreateFlow() {
  openFlowForm();
}

function openMaster() {
  const flows = sortedFlows();
  const rows = flows.length
    ? flows.map((flow) => `
        <div class="master-row">
          <div>
            <strong>${escapeHtml(flow.title)}</strong>
            <div class="task-meta">${flowBadge(flow)}${escapeHtml(flow.category)} · ${escapeHtml(flow.schedule)}</div>
          </div>
          <div class="flow-actions">
            <button type="button" class="edit" data-flow-edit="${escapeHtml(flow.id)}" aria-label="Edit ${escapeHtml(flow.title)}">${ICONS.edit}</button>
            <button type="button" class="switch${flow.enabled ? " on" : ""}" data-flow-toggle="${escapeHtml(flow.id)}" aria-pressed="${flow.enabled}" aria-label="Auto-generate ${escapeHtml(flow.title)}"></button>
          </div>
        </div>
      `).join("")
    : `<p class="empty-note">No recurring flows yet.</p>`;
  openModal("Master list", rows);
}

function completionOf(tasks) {
  if (!tasks.length) return 0;
  const done = tasks.filter((task) => task.completed).length;
  return Math.round((done / tasks.length) * 100);
}

function openAnalytics() {
  const { total, done, remaining, pct } = stats(state.tasks);
  const morning = state.tasks.filter((task) => {
    const mins = minutesOf(task.time);
    return mins !== null && mins < 12 * 60;
  });
  const afternoon = state.tasks.filter((task) => {
    const mins = minutesOf(task.time);
    return mins !== null && mins >= 12 * 60;
  });
  const categories = ["Work", "Personal", "Health"].map((category) => {
    const items = state.tasks.filter((task) => task.category === category);
    return { category, total: items.length, pct: completionOf(items) };
  });
  const priorities = ["high", "medium", "low"].map((priority) => {
    const items = state.tasks.filter((task) => task.priority === priority);
    return { priority, total: items.length, pct: completionOf(items) };
  });
  const bars = (rows, labelOf) => rows.map((row) => `
    <div class="break-row">
      <p><span>${escapeHtml(labelOf(row))}</span><span>${row.total ? `${row.pct}%` : "—"}</span></p>
      <div class="bar-line"><span style="width:${row.total ? row.pct : 0}%"></span></div>
    </div>
  `).join("");

  openModal("Focus efficiency", `
    <div class="stats-grid">
      <div class="stat"><b>${pct}%</b><span>Complete</span></div>
      <div class="stat"><b>${done}</b><span>Cleared</span></div>
      <div class="stat"><b>${remaining}</b><span>Remaining</span></div>
    </div>
    <div class="break-row">
      <p><span>Before noon</span><span>${morning.length ? `${completionOf(morning)}%` : "—"}</span></p>
      <div class="bar-line"><span style="width:${morning.length ? completionOf(morning) : 0}%"></span></div>
    </div>
    <div class="break-row">
      <p><span>After noon</span><span>${afternoon.length ? `${completionOf(afternoon)}%` : "—"}</span></p>
      <div class="bar-line"><span style="width:${afternoon.length ? completionOf(afternoon) : 0}%"></span></div>
    </div>
    <h4 class="pop-label" style="margin-top:16px">By category</h4>
    ${bars(categories, (row) => `${row.category} · ${row.total}`)}
    <h4 class="pop-label" style="margin-top:16px">By priority</h4>
    ${bars(priorities, (row) => `${row.priority.charAt(0).toUpperCase()}${row.priority.slice(1)} · ${row.total}`)}
    <p class="empty-note">Based on ${total} task${total === 1 ? "" : "s"} on this board.</p>
  `);
}

function focusTask(id) {
  state.filter = "all";
  state.search = "";
  state.priorities = [];
  state.categories = [];
  $("search").value = "";
  $("filter-pop").querySelectorAll("input").forEach((input) => {
    input.checked = false;
  });
  renderFilterState();
  setFilter("all");
  const row = document.querySelector(`.task[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.classList.add("flash");
}

function isTyping(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function bind() {
  const list = $("task-list");

  $("search").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderTasks();
  });

  document.querySelector(".tabs").addEventListener("click", (event) => {
    const tab = event.target.closest(".tab");
    if (!tab) return;
    setFilter(tab.dataset.filter);
  });

  $("filter-pop").addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const bucket = input.name === "priority" ? state.priorities : state.categories;
    const index = bucket.indexOf(input.value);
    if (input.checked && index < 0) bucket.push(input.value);
    if (!input.checked && index >= 0) bucket.splice(index, 1);
    renderFilterState();
    renderTasks();
  });

  $("clear-filters").addEventListener("click", () => {
    state.priorities = [];
    state.categories = [];
    $("filter-pop").querySelectorAll("input").forEach((input) => {
      input.checked = false;
    });
    renderFilterState();
    renderTasks();
  });

  $("add-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("new-task");
    const title = input.value.trim();
    if (!title) {
      input.classList.remove("shake");
      void input.offsetWidth;
      input.classList.add("shake");
      input.focus();
      return;
    }
    const taskDate = state.selectedDate;
    input.value = "";
    try {
      const task = await api("/api/tasks", {
        method: "POST",
        body: {
          title,
          priority: $("new-priority").value,
          category: "Work",
          time: formatNow(),
          taskDate
        }
      });
      if (task.taskDate !== state.selectedDate) return;
      state.tasks.push(task);
      if (state.filter === "completed") state.filter = "all";
      refresh();
      setFilter(state.filter);
      const row = document.querySelector(`.task[data-id="${CSS.escape(task.id)}"]`);
      if (row) row.scrollIntoView({ behavior: "smooth", block: "nearest" });
      toast("Task added");
    } catch (error) {
      input.value = title;
      toast(error.message);
    }
  });

  $("copy-yesterday").addEventListener("click", async () => {
    const button = $("copy-yesterday");
    const today = todayIso();
    const yesterday = shiftDate(today, -1);
    button.disabled = true;
    try {
      const result = await api("/api/tasks/copy-remaining", {
        method: "POST",
        body: { from: yesterday, to: today }
      });
      const copied = result.tasks || [];
      if (state.selectedDate === today && copied.length) {
        state.tasks.push(...copied);
        if (state.filter === "completed") state.filter = "all";
        refresh();
        setFilter(state.filter);
      }
      if (!copied.length && !result.skipped) toast("No remaining tasks from yesterday");
      else if (!copied.length) toast("Those tasks are already on today");
      else toast(copied.length === 1 ? "Copied 1 task from yesterday" : `Copied ${copied.length} tasks from yesterday`);
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  });

  list.addEventListener("click", (event) => {
    const row = event.target.closest(".task");
    if (!row) return;
    const id = row.dataset.id;
    if (event.target.closest(".check")) {
      event.stopPropagation();
      toggleTask(id);
      return;
    }
    if (event.target.closest(".more")) {
      event.stopPropagation();
      state.renamingId = null;
      state.menuTaskId = state.menuTaskId === id ? null : id;
      closePopovers();
      renderTasks();
      if (state.menuTaskId) positionMenu(id);
      return;
    }
    const action = event.target.closest("[data-action]");
    if (action) {
      event.stopPropagation();
      handleAction(id, action);
    }
  });

  list.addEventListener("focusout", (event) => {
    const input = event.target.closest(".rename-input");
    if (!input) return;
    if (cancelRename) {
      cancelRename = false;
      return;
    }
    const row = input.closest(".task");
    if (row) saveRename(row.dataset.id, input.value);
  });

  list.addEventListener("keydown", (event) => {
    const input = event.target.closest(".rename-input");
    if (!input) return;
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelRename = true;
      state.renamingId = null;
      renderTasks();
    }
  });

  $("flow-list").addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-flow-toggle]");
    const remove = event.target.closest("[data-flow-delete]");
    const edit = event.target.closest("[data-flow-edit]");
    if (toggle) toggleFlow(toggle.dataset.flowToggle);
    if (remove) deleteFlow(remove.dataset.flowDelete);
    if (edit) {
      const flow = state.flows.find((item) => item.id === edit.dataset.flowEdit);
      if (flow) openFlowForm(flow);
    }
  });

  $("modal-body").addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-flow-toggle]");
    const edit = event.target.closest("[data-flow-edit]");
    if (toggle) toggleFlow(toggle.dataset.flowToggle);
    if (edit) {
      const flow = state.flows.find((item) => item.id === edit.dataset.flowEdit);
      if (flow) openFlowForm(flow, { returnToMaster: true });
    }
  });

  $("modal-body").addEventListener("submit", async (event) => {
    if (event.target.id !== "flow-form") return;
    event.preventDefault();
    const data = new FormData(event.target);
    const title = String(data.get("title") || "").trim();
    if (!title) return;
    const schedule = `${data.get("repeats")} • ${formatTimeValue(data.get("time"))}`;
    const category = String(data.get("category") || "Work");
    const priority = String(data.get("priority") || "medium");
    const id = event.target.dataset.id;
    try {
      if (id) {
        const saved = await api(`/api/flows/${id}`, {
          method: "PATCH",
          body: { title, priority, category, schedule }
        });
        const flow = state.flows.find((item) => item.id === id);
        if (flow) Object.assign(flow, saved);
        renderFlows();
        const backToMaster = returnToMaster;
        returnToMaster = false;
        closeModal();
        if (backToMaster) openMaster();
        toast("Recurring flow updated");
      } else {
        const flow = await api("/api/flows", {
          method: "POST",
          body: { title, priority, category, schedule, enabled: true }
        });
        state.flows.push(flow);
        renderFlows();
        closeModal();
        toast("Recurring flow created. It will show on the next matching day.");
      }
    } catch (error) {
      toast(error.message);
    }
  });

  $("bell-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    openPopover("bell-btn", "notif-pop", renderNotifs);
  });

  $("avatar-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    openPopover("avatar-btn", "avatar-pop");
  });

  $("filter-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    openPopover("filter-btn", "filter-pop");
  });

  $("notif-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-focus-task]");
    if (!button) return;
    closePopovers();
    focusTask(button.dataset.focusTask);
  });

  $("clear-completed").addEventListener("click", async () => {
    const removed = state.tasks.filter((task) => task.completed);
    closePopovers();
    if (!removed.length) {
      toast("No completed tasks");
      return;
    }
    const date = state.selectedDate;
    state.tasks = state.tasks.filter((task) => !task.completed);
    refresh();
    try {
      await api(`/api/tasks?date=${date}&completed=true`, { method: "DELETE" });
    } catch (error) {
      state.tasks = state.tasks.concat(removed);
      refresh();
      toast(error.message);
      return;
    }
    toast(`Cleared ${removed.length} completed`, async () => {
      try {
        for (const task of removed) {
          await api("/api/tasks", {
            method: "POST",
            body: {
              title: task.title,
              priority: task.priority,
              category: task.category,
              time: task.time,
              completed: true,
              taskDate: date,
              sortOrder: task.sortOrder
            }
          });
        }
        if (state.selectedDate === date) await loadTasks();
      } catch (error) {
        toast(error.message);
      }
    });
  });

  $("logout").addEventListener("click", async () => {
    closePopovers();
    try {
      await api("/api/logout", { method: "POST" });
    } catch (error) {
      toast(error.message);
    }
    state.tasks = [];
    state.flows = [];
    showAuth();
  });

  $("prev-day").addEventListener("click", () => {
    setSelectedDate(shiftDate(state.selectedDate, -1));
  });

  $("next-day").addEventListener("click", () => {
    setSelectedDate(shiftDate(state.selectedDate, 1));
  });

  $("date-input").addEventListener("change", (event) => {
    if (event.target.value) setSelectedDate(event.target.value);
  });

  $("back-today").addEventListener("click", () => {
    setSelectedDate(todayIso());
  });

  $("auth-switch").addEventListener("click", () => {
    state.authMode = state.authMode === "login" ? "register" : "login";
    $("auth-error").hidden = true;
    renderAuth();
  });

  $("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const email = String(data.get("email") || "").trim();
    const password = String(data.get("password") || "");
    const errorEl = $("auth-error");
    errorEl.hidden = true;
    try {
      const path = state.authMode === "register" ? "/api/register" : "/api/login";
      const user = await api(path, { method: "POST", body: { email, password } });
      event.target.reset();
      await enterApp(user);
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
    }
  });

  $("view-master").addEventListener("click", openMaster);
  $("create-flow").addEventListener("click", openCreateFlow);
  $("open-analytics").addEventListener("click", openAnalytics);
  $("modal-close").addEventListener("click", closeModal);

  $("modal-back").addEventListener("click", (event) => {
    if (event.target === $("modal-back")) closeModal();
  });

  $("toast-undo").addEventListener("click", () => {
    const action = undoFn;
    undoFn = null;
    $("toast").hidden = true;
    if (action) action();
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".filter-wrap")) {
      $("filter-pop").hidden = true;
      $("filter-btn").setAttribute("aria-expanded", "false");
    }
    if (!event.target.closest(".bell-wrap")) {
      $("notif-pop").hidden = true;
      $("bell-btn").setAttribute("aria-expanded", "false");
    }
    if (!event.target.closest(".avatar-wrap")) {
      $("avatar-pop").hidden = true;
      $("avatar-btn").setAttribute("aria-expanded", "false");
    }
    if (state.menuTaskId && !event.target.closest(".menu") && !event.target.closest(".more")) {
      state.menuTaskId = null;
      renderTasks();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!$("modal-back").hidden) {
        closeModal();
        return;
      }
      closePopovers();
      if (state.menuTaskId) {
        state.menuTaskId = null;
        renderTasks();
      }
      return;
    }
    if (event.key === "/" && !isTyping(event.target)) {
      event.preventDefault();
      $("search").focus();
    }
  });
}

async function init() {
  state.selectedDate = todayIso();
  bind();
  renderDateChrome();
  try {
    const user = await api("/api/me", { quiet: true });
    await enterApp(user);
  } catch (error) {
    if (error.status !== 401 && state.user) {
      toast(error.message);
      return;
    }
    showAuth();
    if (error.status !== 401) {
      $("auth-error").textContent = error.message;
      $("auth-error").hidden = false;
    }
  }
}

init();
