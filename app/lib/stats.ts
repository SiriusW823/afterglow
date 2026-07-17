export type FocusSession = {
  id: string;
  minutes: number;
  completedAt: string;
  updatedAt: string;
  deletedAt?: string;
  source?: "timer" | "manual";
  label?: string;
  note?: string;
  rating?: 1 | 2 | 3;
};

function activeSessions(sessions: FocusSession[]) {
  return sessions.filter((session) => !session.deletedAt);
}

export function localDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function weeklyStats(sessions: FocusSession[], now = new Date()) {
  const active = activeSessions(sessions);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(now.getDate() - (6 - index));
    const key = localDateKey(date);
    return {
      key,
      date,
      minutes: active
        .filter((session) => localDateKey(new Date(session.completedAt)) === key)
        .reduce((sum, session) => sum + session.minutes, 0),
    };
  });
}

export function focusStreak(sessions: FocusSession[], now = new Date()) {
  const activeDays = new Set(activeSessions(sessions).map((session) => localDateKey(new Date(session.completedAt))));
  const cursor = new Date(now);
  cursor.setHours(12, 0, 0, 0);

  if (!activeDays.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);

  let streak = 0;
  while (activeDays.has(localDateKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export function bestFocusHour(sessions: FocusSession[]) {
  const active = activeSessions(sessions);
  if (active.length === 0) return null;
  const totals = new Map<number, number>();
  for (const session of active) {
    const hour = new Date(session.completedAt).getHours();
    totals.set(hour, (totals.get(hour) ?? 0) + session.minutes);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
