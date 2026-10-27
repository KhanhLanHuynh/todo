"use strict";

function utcDate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function daysBetween(fromIso, toIso) {
  return Math.round((utcDate(toIso) - utcDate(fromIso)) / 86400000);
}

function weekday(iso) {
  return utcDate(iso).getUTCDay();
}

function lastDayOfMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function repeatOf(schedule) {
  const kind = String(schedule || "").split("•")[0].trim().toLowerCase().replace(/\s+/g, " ");
  if (kind === "weekdays" || (kind.includes("mon") && kind.includes("fri"))) return "weekdays";
  if (kind.startsWith("bi-weekly") || kind.startsWith("biweekly") || kind.startsWith("e/o")) return "biweekly";
  if (kind.startsWith("weekly")) return "weekly";
  if (kind.startsWith("monthly")) return "monthly";
  return "daily";
}

function timeOf(schedule) {
  const match = String(schedule || "").match(/(\d{1,2}:\d{2}\s*[AP]M)/i);
  if (!match) return "8:00 AM";
  return match[1].replace(/\s+/g, " ").toUpperCase();
}

function scheduleMatches(schedule, createdIso, targetIso) {
  const delta = daysBetween(createdIso, targetIso);
  if (delta < 1) return false;
  const repeat = repeatOf(schedule);
  if (repeat === "daily") return true;
  if (repeat === "weekdays") {
    const day = weekday(targetIso);
    return day >= 1 && day <= 5;
  }
  if (repeat === "weekly") return weekday(targetIso) === weekday(createdIso);
  if (repeat === "biweekly") return delta % 14 === 0;
  if (repeat === "monthly") {
    const created = utcDate(createdIso);
    const target = utcDate(targetIso);
    const last = lastDayOfMonth(target.getUTCFullYear(), target.getUTCMonth());
    return target.getUTCDate() === Math.min(created.getUTCDate(), last);
  }
  return false;
}

module.exports = { scheduleMatches, timeOf, repeatOf };
