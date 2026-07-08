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

const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 30_000;

export type ScheduleRunRequest = z.infer<typeof scheduleRunRequestSchema>;

export function loadScheduleRunRequests(home: string): ScheduleRunRequest[] {
  assertInitialized(home);
  return readScheduleRunRequests(home);
}

export function addScheduleRunRequest(home: string, scheduleId: string, now = new Date()): ScheduleRunRequest {
  const request: ScheduleRunRequest = {
    id: randomUUID(),
    scheduleId,
    requestedAt: now.toISOString()
  };

  updateScheduleRunRequests(home, (requests) => [...requests, request]);
  return request;
}

export function removeScheduleRunRequest(home: string, id: string): void {
  updateScheduleRunRequests(home, (requests) => requests.filter((request) => request.id !== id));
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

function updateScheduleRunRequests(home: string, update: (requests: ScheduleRunRequest[]) => ScheduleRunRequest[]): void {
  assertInitialized(home);
  withScheduleRunRequestLock(home, () => {
    writeScheduleRunRequests(home, update(readScheduleRunRequests(home)));
  });
}

function readScheduleRunRequests(home: string): ScheduleRunRequest[] {
  return scheduleRunRequestsFileSchema.parse(readJson(scheduleRunRequestsPath(home), { requests: [] })).requests;
}

function writeScheduleRunRequests(home: string, requests: ScheduleRunRequest[]): void {
  const body = scheduleRunRequestsFileSchema.parse({ requests });
  const filePath = scheduleRunRequestsPath(home);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function withScheduleRunRequestLock<T>(home: string, task: () => T): T {
  const filePath = scheduleRunRequestsPath(home);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  while (true) {
    let fd: number | undefined;
    let lockOwner: string | undefined;

    try {
      lockOwner = `${process.pid}:${randomUUID()}`;
      fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, `${lockOwner}\n${new Date().toISOString()}\n`);
      return task();
    } catch (error) {
      if (fd !== undefined) {
        throw error;
      }

      if (errorCode(error) !== "EEXIST") {
        throw error;
      }

      removeStaleLock(lockPath);

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for schedule run request lock: ${lockPath}`);
      }

      sleepSync(LOCK_RETRY_MS);
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);

        if (lockOwner) {
          removeOwnedLock(lockPath, lockOwner);
        }
      }
    }
  }
}

function removeOwnedLock(lockPath: string, lockOwner: string): void {
  try {
    if (fs.readFileSync(lockPath, "utf8").split("\n", 1)[0] === lockOwner) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

function removeStaleLock(lockPath: string): void {
  try {
    const staleStat = fs.statSync(lockPath);

    if (Date.now() - staleStat.mtimeMs > LOCK_STALE_MS) {
      const currentStat = fs.statSync(lockPath);

      if (sameLockFile(staleStat, currentStat)) {
        fs.rmSync(lockPath, { force: true });
      }
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

function sameLockFile(left: fs.Stats, right: fs.Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}
