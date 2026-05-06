import { printTable, statusLabel } from "../lib/format.js";
import { openPath } from "../lib/open.js";
import { schedulesPath, slugifyId } from "../lib/paths.js";
import { addSchedule, findSchedule, loadSchedules, pauseSchedule, removeSchedule, resumeSchedule } from "../lib/schedules.js";
import type { Schedule, ScheduleKind, Weekday } from "../lib/types.js";
import type { CommandOptions } from "./options.js";
import { homeFromOptions, numberOption, stringOption } from "./options.js";

export async function addScheduleCommand(kind: string, options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const schedule = buildSchedule(kind, options);
  addSchedule(home, schedule);
  console.log(`Schedule ${schedule.id} created.`);
}

export function listSchedulesCommand(options: CommandOptions): void {
  const schedules = loadSchedules(homeFromOptions(options));

  console.log("Schedules\n");

  if (schedules.length === 0) {
    console.log("No schedules configured.");
    return;
  }

  console.log(
    printTable(
      ["ID", "Kind", "Endpoint", "Status", "Target"],
      schedules.map((schedule) => [
        schedule.id,
        schedule.kind,
        schedule.endpoint,
        statusLabel(schedule.enabled),
        schedule.target
      ])
    )
  );
}

export function showScheduleCommand(id: string, options: CommandOptions): void {
  const schedule = findSchedule(homeFromOptions(options), id);

  console.log(`Schedule ${schedule.id}\n`);
  console.log(`Kind       ${schedule.kind}`);
  console.log(`Endpoint   ${schedule.endpoint}`);
  console.log(`Status     ${statusLabel(schedule.enabled)}`);
  console.log(`Target     ${schedule.target}`);
  console.log(`Message    ${schedule.message}`);

  if (schedule.time) {
    console.log(`Time       ${schedule.time}`);
  }

  if (schedule.timezone) {
    console.log(`Timezone   ${schedule.timezone}`);
  }

  if (schedule.weekday) {
    console.log(`Weekday    ${schedule.weekday}`);
  }

  if (schedule.startDate) {
    console.log(`StartDate  ${schedule.startDate}`);
  }

  if (schedule.runAt) {
    console.log(`RunAt      ${schedule.runAt}`);
  }
}

export function pauseScheduleCommand(id: string, options: CommandOptions): void {
  pauseSchedule(homeFromOptions(options), id);
  console.log(`Paused schedule ${id}.`);
}

export function resumeScheduleCommand(id: string, options: CommandOptions): void {
  resumeSchedule(homeFromOptions(options), id);
  console.log(`Resumed schedule ${id}.`);
}

export function removeScheduleCommand(id: string, options: CommandOptions): void {
  removeSchedule(homeFromOptions(options), id);
  console.log(`Removed schedule ${id}.`);
}

export async function openScheduleConfigCommand(options: CommandOptions): Promise<void> {
  await openPath(schedulesPath(homeFromOptions(options)));
}

function buildSchedule(kindValue: string, options: CommandOptions): Schedule {
  const kind = parseKind(kindValue);
  const id = slugifyId(requiredOption(options, "id"));
  const endpoint = slugifyId(requiredOption(options, "endpoint"));
  const target = requiredOption(options, "target");
  const message = requiredOption(options, "message");

  if (id.length === 0) {
    throw new Error("Schedule id must contain at least one letter or number.");
  }

  if (endpoint.length === 0) {
    throw new Error("Endpoint id must contain at least one letter or number.");
  }

  const base = {
    id,
    endpoint,
    enabled: true,
    kind,
    target,
    message
  };

  switch (kind) {
    case "hourly":
      return {
        ...base,
        minute: optionalNumberOption(options, "minute", 0),
        timezone: timezoneOption(options)
      };
    case "daily":
      return {
        ...base,
        time: requiredOption(options, "time"),
        timezone: timezoneOption(options)
      };
    case "weekly":
      return {
        ...base,
        weekday: parseWeekday(requiredOption(options, "weekday")),
        time: requiredOption(options, "time"),
        timezone: timezoneOption(options)
      };
    case "biweekly":
      return {
        ...base,
        weekday: parseWeekday(requiredOption(options, "weekday")),
        startDate: requiredOption(options, "startDate"),
        time: requiredOption(options, "time"),
        timezone: timezoneOption(options)
      };
    case "monthly":
      return {
        ...base,
        day: optionalNumberOption(options, "day", 1),
        time: requiredOption(options, "time"),
        timezone: timezoneOption(options)
      };
    case "once":
      return {
        ...base,
        runAt: requiredOption(options, "runAt")
      };
  }
}

function requiredOption(options: CommandOptions, key: string): string {
  const value = stringOption(options, key);

  if (value) {
    return value;
  }

  throw new Error(`Missing required option: --${kebab(key)}`);
}

function timezoneOption(options: CommandOptions): string {
  return stringOption(options, "timezone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

function optionalNumberOption(options: CommandOptions, key: string, fallback: number): number {
  if (options[key] === undefined) {
    return fallback;
  }

  const value = numberOption(options, key);

  if (value !== undefined) {
    return value;
  }

  throw new Error(`Invalid numeric option: --${kebab(key)}`);
}

function parseKind(value: string): ScheduleKind {
  const kinds: ScheduleKind[] = ["hourly", "daily", "weekly", "biweekly", "monthly", "once"];

  if (kinds.includes(value as ScheduleKind)) {
    return value as ScheduleKind;
  }

  throw new Error(`Unsupported schedule kind: ${value}`);
}

function parseWeekday(value: string): Weekday {
  const normalized = value.toLowerCase();
  const weekdays: Weekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  if (weekdays.includes(normalized as Weekday)) {
    return normalized as Weekday;
  }

  throw new Error(`Unsupported weekday: ${value}`);
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
