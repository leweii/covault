/**
 * Automation schedules: "every N hours" or "every day at HH:MM" (local
 * time). Pure functions, so the scheduler's arithmetic is testable
 * without timers.
 *
 * Missed runs are skipped, not caught up: the plugin only runs while
 * Obsidian is open, and a job that fires the moment the laptop wakes —
 * hours after it was meant to — is usually worse than one that waits for
 * its next slot.
 */

export type Schedule = { kind: "interval"; hours: number } | { kind: "daily"; hour: number; minute: number };

export const MIN_INTERVAL_HOURS = 1;
export const MAX_INTERVAL_HOURS = 24 * 7;

/**
 * How late a due run may still start. The scheduler ticks every 30 s, so
 * a healthy run is never more than a tick late; anything later means the
 * machine slept (or Obsidian was closed) through the slot.
 */
export const LATE_GRACE_MS = 10 * 60_000;

/** Validate and normalize a schedule from untrusted input (the model, a file). */
export function parseSchedule(raw: unknown): Schedule {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.kind === "interval") {
    const hours = Number(r.hours);
    if (!Number.isInteger(hours) || hours < MIN_INTERVAL_HOURS || hours > MAX_INTERVAL_HOURS) {
      throw new Error(`"every N hours" needs a whole number of hours between ${MIN_INTERVAL_HOURS} and ${MAX_INTERVAL_HOURS}.`);
    }
    return { kind: "interval", hours };
  }
  if (r.kind === "daily") {
    const hour = Number(r.hour);
    const minute = r.minute === undefined ? 0 : Number(r.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new Error('"every day at" needs hour 0–23 and minute 0–59 (local time).');
    }
    return { kind: "daily", hour, minute };
  }
  throw new Error('Schedule kind must be "interval" (every N hours) or "daily" (every day at a time).');
}

/**
 * The first run strictly after `now`.
 *
 * Interval schedules keep their rhythm from `anchor` (the last run, or
 * when the automation was created), so a 6-hour job created at 09:10
 * runs 15:10, 21:10, … and a skipped slot doesn't shift the ones after it.
 */
export function nextRunAfter(schedule: Schedule, now: number, anchor: number): number {
  if (schedule.kind === "interval") {
    const step = schedule.hours * 3_600_000;
    if (anchor > now) return anchor;
    const k = Math.floor((now - anchor) / step) + 1;
    return anchor + k * step;
  }
  const d = new Date(now);
  d.setHours(schedule.hour, schedule.minute, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * The most recent slot at or before `now`, or null if none has come yet.
 * Interval slots fall on anchor + k·hours (k ≥ 1); daily slots on HH:MM.
 */
export function latestSlotAtOrBefore(schedule: Schedule, now: number, anchor: number): number | null {
  if (schedule.kind === "interval") {
    const step = schedule.hours * 3_600_000;
    const k = Math.floor((now - anchor) / step);
    return k >= 1 ? anchor + k * step : null;
  }
  const d = new Date(now);
  d.setHours(schedule.hour, schedule.minute, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "interval") {
    return schedule.hours === 1 ? "Every hour" : `Every ${schedule.hours} hours`;
  }
  const p = (n: number) => String(n).padStart(2, "0");
  return `Every day at ${p(schedule.hour)}:${p(schedule.minute)}`;
}
