import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { assertInitialized, readJson } from "./config.js";
import { appendRuntimeLog } from "./logging.js";
import { runtimeDisplayStatus } from "./runtime-state.js";
import { completedScheduleRunRequestsPath, scheduleRunRequestsPath } from "./paths.js";
import { SCHEDULE_RELOAD_SIGNAL } from "./schedule-reload.js";

const scheduleRunRequestSchema = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  requestedAt: z.string().datetime()
});

const scheduleRunRequestsFileSchema = z.object({
  requests: z.array(scheduleRunRequestSchema).default([])
});
const completedScheduleRunRequestsFileSchema = z.object({
  requests: z.array(z.string().min(1)).default([])
});

const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 30_000;

export type ScheduleRunRequest = z.infer<typeof scheduleRunRequestSchema>;

interface ScheduleRunRequestLock {
  path: string;
  owner: string;
}

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

export function loadCompletedScheduleRunRequests(home: string): Set<string> {
  assertInitialized(home);
  return new Set(completedScheduleRunRequestsFileSchema.parse(readJson(completedScheduleRunRequestsPath(home), { requests: [] })).requests);
}

export function addCompletedScheduleRunRequest(home: string, id: string): void {
  updateCompletedScheduleRunRequests(home, (requests) => (requests.includes(id) ? requests : [...requests, id]));
}

export function removeCompletedScheduleRunRequest(home: string, id: string): void {
  updateCompletedScheduleRunRequests(home, (requests) => requests.filter((requestId) => requestId !== id));
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
  withScheduleRunRequestLock(home, (lock) => {
    writeScheduleRunRequests(home, update(readScheduleRunRequests(home)), lock);
  });
}

function readScheduleRunRequests(home: string): ScheduleRunRequest[] {
  return scheduleRunRequestsFileSchema.parse(readJson(scheduleRunRequestsPath(home), { requests: [] })).requests;
}

function updateCompletedScheduleRunRequests(home: string, update: (requests: string[]) => string[]): void {
  assertInitialized(home);
  writeCompletedScheduleRunRequests(home, update([...loadCompletedScheduleRunRequests(home)]));
}

function writeCompletedScheduleRunRequests(home: string, requests: string[]): void {
  const body = completedScheduleRunRequestsFileSchema.parse({ requests });
  const filePath = completedScheduleRunRequestsPath(home);
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

function writeScheduleRunRequests(home: string, requests: ScheduleRunRequest[], lock: ScheduleRunRequestLock): void {
  const body = scheduleRunRequestsFileSchema.parse({ requests });
  const filePath = scheduleRunRequestsPath(home);
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tempPath, 0o600);
    assertOwnedLock(lock);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function withScheduleRunRequestLock<T>(home: string, task: (lock: ScheduleRunRequestLock) => T): T {
  const filePath = scheduleRunRequestsPath(home);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  while (true) {
    let lock: ScheduleRunRequestLock | undefined;

    try {
      lock = acquireLock(lockPath);
      return task(lock);
    } catch (error) {
      if (lock !== undefined) {
        throw error;
      }

      if (!isLockExistsError(error)) {
        throw error;
      }

      removeStaleLock(lockPath);

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for schedule run request lock: ${lockPath}`);
      }

      sleepSync(LOCK_RETRY_MS);
    } finally {
      if (lock !== undefined) {
        removeOwnedLock(lock.path, lock.owner);
      }
    }
  }
}

function assertOwnedLock(lock: ScheduleRunRequestLock): void {
  try {
    if (lockOwner(lock.path) !== lock.owner) {
      throw new Error(`Lost schedule run request lock ownership: ${lock.path}`);
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`Lost schedule run request lock ownership: ${lock.path}`);
    }

    throw error;
  }
}

function acquireLock(lockPath: string): ScheduleRunRequestLock {
  const owner = `${process.pid}.${randomUUID()}`;
  const tempPath = `${lockPath}.${owner}.tmp`;

  fs.mkdirSync(tempPath, { mode: 0o700 });
  try {
    fs.writeFileSync(lockOwnerPath(tempPath, owner), `${owner}\n${new Date().toISOString()}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, lockPath);
    return { path: lockPath, owner };
  } catch (error) {
    fs.rmSync(tempPath, { recursive: true, force: true });
    throw error;
  }
}

function removeOwnedLock(lockPath: string, lockOwner: string): void {
  try {
    fs.unlinkSync(lockOwnerPath(lockPath, lockOwner));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }

    throw error;
  }

  try {
    fs.rmdirSync(lockPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTEMPTY") {
      throw error;
    }
  }
}

function removeStaleLock(lockPath: string): void {
  withStaleLockCleanupLock(lockPath, () => {
    removeStaleLockFile(lockPath);
  });
}

function removeStaleLockFile(lockPath: string): void {
  try {
    const staleStat = fs.statSync(lockPath);
    const staleOwner = lockOwner(lockPath);

    if (staleOwner && Date.now() - staleStat.mtimeMs > LOCK_STALE_MS && !lockOwnerIsAlive(staleOwner)) {
      const currentStat = fs.statSync(lockPath);
      const currentOwner = lockOwner(lockPath);

      if (sameLockFile(staleStat, currentStat) && currentOwner === staleOwner && !lockOwnerIsAlive(currentOwner)) {
        removeOwnedLock(lockPath, currentOwner);
      }
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

function lockOwner(lockPath: string): string {
  return fs.readdirSync(lockPath)[0] ?? "";
}

function lockOwnerPath(lockPath: string, owner: string): string {
  return path.join(lockPath, owner);
}

function lockOwnerIsAlive(owner: string): boolean {
  const pid = Number(owner.split(/[.:]/, 1)[0]);

  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function withStaleLockCleanupLock<T>(lockPath: string, task: () => T): T | undefined {
  const cleanupLockPath = `${lockPath}.cleanup`;
  let lock: ScheduleRunRequestLock | undefined;

  try {
    lock = acquireLock(cleanupLockPath);
    return task();
  } catch (error) {
    if (lock !== undefined) {
      throw error;
    }

    if (isLockExistsError(error)) {
      removeStaleLockFile(cleanupLockPath);
      return undefined;
    }

    throw error;
  } finally {
    if (lock !== undefined) {
      removeOwnedLock(lock.path, lock.owner);
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

function isLockExistsError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR";
}
