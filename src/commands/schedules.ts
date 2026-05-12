import { printTable, statusLabel } from "../lib/format.js";
import { openPath } from "../lib/open.js";
import { schedulesPath } from "../lib/paths.js";
import { findSchedule, loadSchedules } from "../lib/schedules.js";
import type { CommandOptions } from "./options.js";
import { homeFromOptions, stringOption } from "./options.js";

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

export function showScheduleCommand(options: CommandOptions): void {
  const id = requiredOption(options, "id");
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

  if (schedule.cron) {
    console.log(`Cron       ${schedule.cron}`);
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

export async function openScheduleConfigCommand(options: CommandOptions): Promise<void> {
  await openPath(schedulesPath(homeFromOptions(options)));
}

function requiredOption(options: CommandOptions, key: string): string {
  const value = stringOption(options, key);

  if (value) {
    return value;
  }

  throw new Error(`Missing required option: --${kebab(key)}`);
}

function kebab(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
