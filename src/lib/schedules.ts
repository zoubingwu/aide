import fs from "node:fs";
import { z } from "zod";
import { assertInitialized, readToml, stringifyToml } from "./config.js";
import { schedulesPath } from "./paths.js";
import type { Schedule, SchedulesFile } from "./types.js";

const idSchema = z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const targetSchema = z.string().min(3);
const timezoneSchema = z.string().min(1);
const weekdaySchema = z.enum(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);
const baseScheduleSchema = z.object({
  id: idSchema,
  endpoint: idSchema,
  enabled: z.boolean().default(true),
  target: targetSchema,
  message: z.string().min(1)
});

const scheduleSchema = z.discriminatedUnion("kind", [
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

const schedulesFileSchema = z.object({
  schedules: z.array(scheduleSchema).default([])
});

export function loadSchedules(home: string): Schedule[] {
  assertInitialized(home);
  return schedulesFileSchema.parse(readToml(schedulesPath(home))).schedules;
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
