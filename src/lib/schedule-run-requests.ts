import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { assertInitialized, readJson } from "./config.js";
import { appendRuntimeLog } from "./logging.js";
import { runtimeDisplayStatus } from "./runtime-state.js";
import { scheduleRunRequestsPath } from "./paths.js";
import { SCHEDULE_RELOAD_SIGNAL } from "./schedule-reload.js";

const scheduleRunRequestSchema = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  requestedAt: z.string().datetime()
});

const scheduleRunRequestsFileSchema = z.object({
  requests: z.array(scheduleRunRequestSchema).default([])
});

export type ScheduleRunRequest = z.infer<typeof scheduleRunRequestSchema>;

export function loadScheduleRunRequests(home: string): ScheduleRunRequest[] {
  assertInitialized(home);
  return scheduleRunRequestsFileSchema.parse(readJson(scheduleRunRequestsPath(home), { requests: [] })).requests;
}

export function addScheduleRunRequest(home: string, scheduleId: string, now = new Date()): ScheduleRunRequest {
  const request: ScheduleRunRequest = {
    id: randomUUID(),
    scheduleId,
    requestedAt: now.toISOString()
  };

  writeScheduleRunRequests(home, [...loadScheduleRunRequests(home), request]);
  return request;
}

export function takeScheduleRunRequests(home: string): ScheduleRunRequest[] {
  const requests = loadScheduleRunRequests(home);
  writeScheduleRunRequests(home, []);
  return requests;
}

export function removeScheduleRunRequest(home: string, id: string): void {
  writeScheduleRunRequests(home, loadScheduleRunRequests(home).filter((request) => request.id !== id));
}

export function requestScheduleRun(home: string, scheduleId: string): boolean {
  const runtime = runtimeDisplayStatus(home);

  if (runtime.status !== "running" || !runtime.pid) {
    return false;
  }

  const request = addScheduleRunRequest(home, scheduleId);

  try {
    process.kill(runtime.pid, SCHEDULE_RELOAD_SIGNAL);
    appendRuntimeLog(home, "schedule_run_requested", {
      schedule: scheduleId,
      request: request.id,
      pid: runtime.pid
    });
    return true;
  } catch (error) {
    removeScheduleRunRequest(home, request.id);
    appendRuntimeLog(home, "schedule_run_request_failed", {
      schedule: scheduleId,
      request: request.id,
      pid: runtime.pid,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

function writeScheduleRunRequests(home: string, requests: ScheduleRunRequest[]): void {
  const body = scheduleRunRequestsFileSchema.parse({ requests });
  const filePath = scheduleRunRequestsPath(home);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}
