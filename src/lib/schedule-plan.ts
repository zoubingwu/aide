import type { Schedule, Weekday } from "./types.js";

export type SchedulePlan =
  | { kind: "cron"; expression: string; timezone: string }
  | { kind: "once"; runAt: string };

const WEEKDAY_TO_CRON: Record<Weekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

export function buildSchedulePlan(schedule: Schedule): SchedulePlan {
  switch (schedule.kind) {
    case "cron":
      return cronPlan(requiredString(schedule.cron, "cron"), schedule);
    case "hourly":
      return cronPlan(`${requiredNumber(schedule.minute, "minute")} * * * *`, schedule);
    case "daily": {
      const { hour, minute } = parseTime(requiredString(schedule.time, "time"));
      return cronPlan(`${minute} ${hour} * * *`, schedule);
    }
    case "weekly": {
      const { hour, minute } = parseTime(requiredString(schedule.time, "time"));
      return cronPlan(`${minute} ${hour} * * ${WEEKDAY_TO_CRON[requiredWeekday(schedule.weekday)]}`, schedule);
    }
    case "biweekly": {
      const { hour, minute } = parseTime(requiredString(schedule.time, "time"));
      return cronPlan(`${minute} ${hour} * * ${WEEKDAY_TO_CRON[requiredWeekday(schedule.weekday)]}`, schedule);
    }
    case "monthly": {
      const { hour, minute } = parseTime(requiredString(schedule.time, "time"));
      return cronPlan(`${minute} ${hour} ${requiredNumber(schedule.day, "day")} * *`, schedule);
    }
    case "once":
      return { kind: "once", runAt: requiredString(schedule.runAt, "runAt") };
  }
}

export function isBiweeklyOccurrence(startDate: string, date: Date, timezone = "UTC"): boolean {
  const anchor = Date.UTC(...dateParts(startDate), 0, 0, 0);
  const current = Date.UTC(...localDateParts(date, timezone), 0, 0, 0);
  const days = Math.floor((current - anchor) / 86_400_000);

  return days >= 0 && days % 14 === 0;
}

function cronPlan(expression: string, schedule: Schedule): SchedulePlan {
  return {
    kind: "cron",
    expression,
    timezone: requiredString(schedule.timezone, "timezone")
  };
}

function parseTime(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(":").map(Number);
  return { hour: hour ?? 0, minute: minute ?? 0 };
}

function requiredString(value: string | undefined, field: string): string {
  if (value) {
    return value;
  }

  throw new Error(`Schedule field is required: ${field}`);
}

function requiredNumber(value: number | undefined, field: string): number {
  if (typeof value === "number") {
    return value;
  }

  throw new Error(`Schedule field is required: ${field}`);
}

function requiredWeekday(value: Weekday | undefined): Weekday {
  if (value) {
    return value;
  }

  throw new Error("Schedule field is required: weekday");
}

function dateParts(value: string): [number, number, number] {
  const [year, month, day] = value.split("-").map(Number);
  return [year ?? 1970, (month ?? 1) - 1, day ?? 1];
}

function localDateParts(date: Date, timezone: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);

  return [value("year"), value("month") - 1, value("day")];
}
