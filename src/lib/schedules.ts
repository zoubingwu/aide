import fs from "node:fs";
import { z } from "zod";
import { assertInitialized, readToml, stringifyToml } from "./config.js";
import { schedulesPath } from "./paths.js";
import type { Schedule, SchedulesFile, Weekday } from "./types.js";

const idSchema = z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const targetSchema = z.string().min(3);
const timezoneSchema = z.string().min(1).refine(isValidTimeZone, { message: "Invalid IANA timezone" });
const weekdaySchema = z.enum(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);
const weekdayIndex: Record<Weekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};
const baseScheduleSchema = z.object({
  id: idSchema,
  endpoint: idSchema,
  enabled: z.boolean().default(true),
  target: targetSchema,
  message: z.string().min(1)
});

const rawScheduleSchema = z.discriminatedUnion("kind", [
  baseScheduleSchema.extend({
    kind: z.literal("hourly"),
    minute: z.number().int().min(0).max(59).default(0),
    timezone: timezoneSchema
  }),
  baseScheduleSchema.extend({
    kind: z.literal("daily"),
    time: timeSchema,
    timezone: timezoneSchema
  }),
  baseScheduleSchema.extend({
    kind: z.literal("weekly"),
    weekday: weekdaySchema,
    time: timeSchema,
    timezone: timezoneSchema
  }),
  baseScheduleSchema.extend({
    kind: z.literal("biweekly"),
    weekday: weekdaySchema,
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: timeSchema,
    timezone: timezoneSchema
  }),
  baseScheduleSchema.extend({
    kind: z.literal("monthly"),
    day: z.number().int().min(1).max(31).default(1),
    time: timeSchema,
    timezone: timezoneSchema
  }),
  baseScheduleSchema.extend({
    kind: z.literal("once"),
    runAt: z.string().datetime({ offset: true })
  })
]);

const scheduleSchema = rawScheduleSchema
  .refine((schedule) => schedule.kind !== "biweekly" || isRealDate(schedule.startDate), {
    path: ["startDate"],
    message: "Invalid calendar date"
  })
  .refine((schedule) => schedule.kind !== "biweekly" || biweeklyStartMatchesWeekday(schedule.startDate, schedule.weekday), {
    path: ["startDate"],
    message: "Biweekly startDate must match weekday"
  });

const schedulesFileSchema = z.object({
  schedules: z.array(scheduleSchema).default([])
});
const looseSchedulesFileSchema = z.object({
  schedules: z.array(z.unknown()).default([])
});

export interface RuntimeSchedules {
  schedules: Schedule[];
  issues: Array<{
    index: number;
    id?: string | undefined;
    error: string;
  }>;
}

export function loadSchedules(home: string): Schedule[] {
  assertInitialized(home);
  return schedulesFileSchema.parse(readToml(schedulesPath(home))).schedules;
}

export function loadRuntimeSchedules(home: string): RuntimeSchedules {
  assertInitialized(home);
  const rawSchedules = looseSchedulesFileSchema.parse(readToml(schedulesPath(home))).schedules;
  const schedules: Schedule[] = [];
  const issues: RuntimeSchedules["issues"] = [];

  for (const [index, rawSchedule] of rawSchedules.entries()) {
    const result = scheduleSchema.safeParse(rawSchedule);

    if (result.success) {
      schedules.push(result.data);
      continue;
    }

    issues.push({
      index,
      id: scheduleId(rawSchedule),
      error: formatZodError(result.error)
    });
  }

  return { schedules, issues };
}

export function writeSchedules(home: string, schedules: Schedule[]): void {
  const body: SchedulesFile = { schedules };
  fs.writeFileSync(schedulesPath(home), stringifyToml(schedulesFileSchema.parse(body)));
}

export function findSchedule(home: string, id: string): Schedule {
  const schedule = loadSchedules(home).find((candidate) => candidate.id === id);

  if (!schedule) {
    throw new Error(`Schedule not found: ${id}`);
  }

  return schedule;
}

export function addSchedule(home: string, schedule: Schedule): void {
  const schedules = loadSchedules(home);

  if (schedules.some((candidate) => candidate.id === schedule.id)) {
    throw new Error(`Schedule already exists: ${schedule.id}`);
  }

  writeSchedules(home, [...schedules, schedule]);
}

export function pauseSchedule(home: string, id: string): void {
  setScheduleEnabled(home, id, false);
}

export function resumeSchedule(home: string, id: string): void {
  setScheduleEnabled(home, id, true);
}

export function removeSchedule(home: string, id: string): void {
  const schedules = loadSchedules(home);
  const next = schedules.filter((schedule) => schedule.id !== id);

  if (next.length === schedules.length) {
    throw new Error(`Schedule not found: ${id}`);
  }

  writeSchedules(home, next);
}

export function removeRuntimeSchedule(home: string, id: string): void {
  assertInitialized(home);
  const raw = readToml(schedulesPath(home));
  const file = looseSchedulesFileSchema.parse(raw);
  const next = file.schedules.filter((schedule) => scheduleId(schedule) !== id);

  if (next.length === file.schedules.length) {
    throw new Error(`Schedule not found: ${id}`);
  }

  fs.writeFileSync(schedulesPath(home), stringifyToml({ schedules: next }));
}

function setScheduleEnabled(home: string, id: string, enabled: boolean): void {
  const schedules = loadSchedules(home);
  const index = schedules.findIndex((schedule) => schedule.id === id);
  const schedule = schedules[index];

  if (!schedule) {
    throw new Error(`Schedule not found: ${id}`);
  }

  schedules[index] = {
    ...schedule,
    enabled
  };
  writeSchedules(home, schedules);
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isRealDate(value: string): boolean {
  const parts = dateParts(value);

  if (!parts) {
    return false;
  }

  const date = utcDate(parts);
  return date.getUTCFullYear() === parts.year && date.getUTCMonth() === parts.month - 1 && date.getUTCDate() === parts.day;
}

function biweeklyStartMatchesWeekday(value: string, weekday: Weekday): boolean {
  const parts = dateParts(value);

  if (!parts || !isRealDate(value)) {
    return true;
  }

  return utcDate(parts).getUTCDay() === weekdayIndex[weekday];
}

function dateParts(value: string): { year: number; month: number; day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    return undefined;
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function utcDate(parts: { year: number; month: number; day: number }): Date {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return date;
}

function scheduleId(value: unknown): string | undefined {
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
    return value.id;
  }

  return undefined;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}
