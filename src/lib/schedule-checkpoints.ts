import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertInitialized, readJson } from "./config.js";
import { scheduleCheckpointsPath } from "./paths.js";

const scheduleCheckpointSchema = z.object({
  lastCheckedAt: z.string().datetime(),
  lastProcessedOccurrenceAt: z.string().datetime().optional()
});

const scheduleCheckpointsFileSchema = z.object({
  schedules: z.record(z.string(), scheduleCheckpointSchema).default({})
});

export type ScheduleCheckpoint = z.infer<typeof scheduleCheckpointSchema>;

export function loadScheduleCheckpoints(home: string): Record<string, ScheduleCheckpoint> {
  assertInitialized(home);
  return scheduleCheckpointsFileSchema.parse(readJson(scheduleCheckpointsPath(home), { schedules: {} })).schedules;
}

export function recordScheduleCheck(home: string, id: string, checkedAt = new Date()): void {
  const checkpoints = loadScheduleCheckpoints(home);
  const current = checkpoints[id];
  checkpoints[id] = {
    ...current,
    lastCheckedAt: maxIso(current?.lastCheckedAt, checkedAt.toISOString())
  };
  writeScheduleCheckpoints(home, checkpoints);
}

export function claimScheduleOccurrence(home: string, id: string, occurrenceAt: Date, checkedAt = new Date()): boolean {
  const checkpoints = loadScheduleCheckpoints(home);
  const current = checkpoints[id];
  const occurrenceIso = occurrenceAt.toISOString();

  if (current?.lastProcessedOccurrenceAt && new Date(current.lastProcessedOccurrenceAt).getTime() >= occurrenceAt.getTime()) {
    return false;
  }

  checkpoints[id] = {
    ...current,
    lastCheckedAt: maxIso(current?.lastCheckedAt, checkedAt.toISOString()),
    lastProcessedOccurrenceAt: occurrenceIso
  };
  writeScheduleCheckpoints(home, checkpoints);
  return true;
}

export function pruneScheduleCheckpoints(home: string, activeIds: Set<string>): void {
  const checkpoints = loadScheduleCheckpoints(home);
  const next = Object.fromEntries(Object.entries(checkpoints).filter(([id]) => activeIds.has(id)));

  if (Object.keys(next).length !== Object.keys(checkpoints).length) {
    writeScheduleCheckpoints(home, next);
  }
}

function writeScheduleCheckpoints(home: string, checkpoints: Record<string, ScheduleCheckpoint>): void {
  const body = scheduleCheckpointsFileSchema.parse({ schedules: checkpoints });
  const filePath = scheduleCheckpointsPath(home);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function maxIso(left: string | undefined, right: string): string {
  if (!left || new Date(left).getTime() < new Date(right).getTime()) {
    return right;
  }

  return left;
}
