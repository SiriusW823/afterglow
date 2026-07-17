import assert from "node:assert/strict";
import test from "node:test";
import { bestFocusHour, focusStreak, weeklyStats } from "../app/lib/stats.ts";

const now = new Date("2026-07-14T12:00:00+08:00");
const sessions = [
  { id: "1", minutes: 25, completedAt: "2026-07-12T09:00:00+08:00", updatedAt: "2026-07-12T09:00:00+08:00" },
  { id: "2", minutes: 50, completedAt: "2026-07-13T09:00:00+08:00", updatedAt: "2026-07-13T09:00:00+08:00" },
  { id: "3", minutes: 25, completedAt: "2026-07-14T09:00:00+08:00", updatedAt: "2026-07-14T09:00:00+08:00" },
  { id: "4", minutes: 10, completedAt: "2026-07-14T10:00:00+08:00", updatedAt: "2026-07-14T10:00:00+08:00" },
];

test("weekly stats aggregate sessions by local calendar day", () => {
  const week = weeklyStats(sessions, now);
  assert.equal(week.length, 7);
  assert.deepEqual(week.slice(-3).map((day) => day.minutes), [25, 50, 35]);
});

test("focus streak counts consecutive active days", () => {
  assert.equal(focusStreak(sessions, now), 3);
});

test("focus streak may continue from yesterday before today's first session", () => {
  assert.equal(focusStreak(sessions.slice(0, 2), now), 2);
});

test("best focus hour returns the hour with the most minutes", () => {
  const expectedLocalHour = new Date(sessions[0].completedAt).getHours();
  assert.equal(bestFocusHour(sessions), expectedLocalHour);
  assert.equal(bestFocusHour([]), null);
});

test("deleted sessions do not appear in statistics", () => {
  const deleted = { ...sessions[3], deletedAt: "2026-07-14T11:00:00+08:00", updatedAt: "2026-07-14T11:00:00+08:00" };
  assert.equal(weeklyStats([...sessions.slice(0, 3), deleted], now).at(-1)?.minutes, 25);
});
