import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAideHome, writeRuntimeState } from "../src/lib/config.js";
import { RUNTIME_LOG_FILE } from "../src/lib/logging.js";
import { logsDir, scheduleRunRequestsPath } from "../src/lib/paths.js";
import {
  addScheduleRunRequest,
  loadScheduleRunRequests,
  removeScheduleRunRequest,
  requestScheduleRun
} from "../src/lib/schedule-run-requests.js";
import { SCHEDULE_RELOAD_SIGNAL } from "../src/lib/schedule-reload.js";

const cleanupPaths: string[] = [];

describe("schedule run requests", () => {
  afterEach(() => {
    vi.restoreAllMocks();

    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("stores and removes manual schedule run requests", () => {
    const home = tempHome();
    ensureAideHome(home);
    const first = addScheduleRunRequest(home, "daily-brief", new Date("2026-05-10T01:00:00.000Z"));
    const second = addScheduleRunRequest(home, "daily-market", new Date("2026-05-10T02:00:00.000Z"));

    expect(loadScheduleRunRequests(home)).toEqual([first, second]);
    removeScheduleRunRequest(home, first.id);
    expect(loadScheduleRunRequests(home)).toEqual([second]);
    expect(fs.statSync(scheduleRunRequestsPath(home)).mode & 0o777).toBe(0o600);
  });

  it("recovers a stale request lock before updating the queue", () => {
    const home = tempHome();
    ensureAideHome(home);
    const lockPath = `${scheduleRunRequestsPath(home)}.lock`;
    const staleAt = new Date(Date.now() - 60_000);
    writeLock(lockPath, "stale", staleAt);

    const request = addScheduleRunRequest(home, "daily-brief", new Date("2026-05-10T01:00:00.000Z"));

    expect(loadScheduleRunRequests(home)).toEqual([request]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("keeps stale request locks owned by live processes", () => {
    const home = tempHome();
    ensureAideHome(home);
    const lockPath = `${scheduleRunRequestsPath(home)}.lock`;
    writeLock(lockPath, `${process.pid}.live-owner`, new Date(0));
    vi.spyOn(Date, "now").mockReturnValueOnce(60_000).mockReturnValue(62_001);

    expect(() => addScheduleRunRequest(home, "daily-brief", new Date("2026-05-10T01:00:00.000Z"))).toThrow(
      "Timed out waiting for schedule run request lock"
    );
    expect(readLockOwner(lockPath)).toBe(`${process.pid}.live-owner`);
    expect(loadScheduleRunRequests(home)).toEqual([]);
  });

  it("keeps a fresh request lock that replaces a stale lock during recovery", () => {
    const home = tempHome();
    ensureAideHome(home);
    const lockPath = `${scheduleRunRequestsPath(home)}.lock`;
    writeLock(lockPath, "stale", new Date(0));
    const statSync = fs.statSync.bind(fs) as (target: fs.PathLike) => fs.Stats;
    let lockStats = 0;
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(60_000)
      .mockReturnValueOnce(60_000)
      .mockReturnValue(62_001);
    vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike) => {
      const stat = statSync(target);

      if (target.toString() === lockPath) {
        lockStats += 1;

        if (lockStats === 1) {
          replaceLock(lockPath, "fresh", new Date(60_000));
        }
      }

      return stat;
    }) as typeof fs.statSync);

    expect(() => addScheduleRunRequest(home, "daily-brief", new Date("2026-05-10T01:00:00.000Z"))).toThrow(
      "Timed out waiting for schedule run request lock"
    );
    expect(readLockOwner(lockPath)).toBe("fresh");
    expect(loadScheduleRunRequests(home)).toEqual([]);
  });

  it("leaves stale lock cleanup to the active cleanup owner", () => {
    const home = tempHome();
    ensureAideHome(home);
    const lockPath = `${scheduleRunRequestsPath(home)}.lock`;
    const cleanupLockPath = `${lockPath}.cleanup`;
    writeLock(lockPath, "stale", new Date(0));
    writeLock(cleanupLockPath, "cleanup-owner");
    vi.spyOn(Date, "now").mockReturnValueOnce(60_000).mockReturnValue(62_001);

    expect(() => addScheduleRunRequest(home, "daily-brief", new Date("2026-05-10T01:00:00.000Z"))).toThrow(
      "Timed out waiting for schedule run request lock"
    );
    expect(readLockOwner(lockPath)).toBe("stale");
    expect(loadScheduleRunRequests(home)).toEqual([]);
  });

  it("recovers stale cleanup locks before stale request locks", () => {
    const home = tempHome();
    ensureAideHome(home);
    const lockPath = `${scheduleRunRequestsPath(home)}.lock`;
    const cleanupLockPath = `${lockPath}.cleanup`;
    writeLock(lockPath, "stale", new Date(0));
    writeLock(cleanupLockPath, "stale-cleanup-owner", new Date(0));

    const request = addScheduleRunRequest(home, "daily-brief", new Date("2026-05-10T01:00:00.000Z"));

    expect(loadScheduleRunRequests(home)).toEqual([request]);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(cleanupLockPath)).toBe(false);
  });

  it("keeps a fresh cleanup lock that replaces a stale cleanup lock during recovery", () => {
    const home = tempHome();
    ensureAideHome(home);
    const lockPath = `${scheduleRunRequestsPath(home)}.lock`;
    const cleanupLockPath = `${lockPath}.cleanup`;
    writeLock(lockPath, "stale", new Date(0));
    writeLock(cleanupLockPath, "stale-cleanup-owner", new Date(0));
    vi.spyOn(Date, "now").mockReturnValueOnce(60_000).mockReturnValue(62_001);
    const readdirSync = fs.readdirSync.bind(fs) as (target: fs.PathLike) => string[];
    let cleanupReads = 0;
    vi.spyOn(fs, "readdirSync").mockImplementation(((target) => {
      const entries = readdirSync(target);

      if (target.toString() === cleanupLockPath) {
        cleanupReads += 1;

        if (cleanupReads === 2) {
          replaceLock(cleanupLockPath, "fresh-cleanup-owner", new Date(60_000));
        }
      }

      return entries;
    }) as typeof fs.readdirSync);

    expect(() => addScheduleRunRequest(home, "daily-brief", new Date("2026-05-10T01:00:00.000Z"))).toThrow(
      "Timed out waiting for schedule run request lock"
    );
    expect(readLockOwner(lockPath)).toBe("stale");
    expect(readLockOwner(cleanupLockPath)).toBe("fresh-cleanup-owner");
    expect(loadScheduleRunRequests(home)).toEqual([]);
  });

  it("keeps a fresh request lock that replaces this process lock before release", () => {
    const home = tempHome();
    ensureAideHome(home);
    const lockPath = `${scheduleRunRequestsPath(home)}.lock`;
    const renameSync = fs.renameSync.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "renameSync").mockImplementation((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      renameSync(oldPath, newPath);

      if (!replaced && newPath.toString() === scheduleRunRequestsPath(home)) {
        replaced = true;
        replaceLock(lockPath, "fresh-owner");
      }
    });

    const request = addScheduleRunRequest(home, "daily-brief", new Date("2026-05-10T01:00:00.000Z"));

    expect(loadScheduleRunRequests(home)).toEqual([request]);
    expect(readLockOwner(lockPath)).toBe("fresh-owner");
  });

  it("does not overwrite the queue after losing lock ownership before write", () => {
    const home = tempHome();
    ensureAideHome(home);
    const filePath = scheduleRunRequestsPath(home);
    const lockPath = `${filePath}.lock`;
    const freshRequest = {
      id: "fresh-request",
      scheduleId: "daily-market",
      requestedAt: "2026-05-10T02:00:00.000Z"
    };
    const writeFileSync = fs.writeFileSync.bind(fs) as (
      file: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions
    ) => void;
    let replaced = false;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((target, data, options) => {
      writeFileSync(target, data, options);

      if (!replaced && typeof target !== "number" && target.toString().endsWith(".tmp")) {
        replaced = true;
        fs.rmSync(lockPath, { recursive: true, force: true });
        fs.mkdirSync(lockPath, { mode: 0o700 });
        writeFileSync(path.join(lockPath, "fresh-owner"), "fresh-owner\n2026-05-10T02:00:00.000Z\n", { mode: 0o600 });
        writeFileSync(filePath, `${JSON.stringify({ requests: [freshRequest] }, null, 2)}\n`, { mode: 0o600 });
      }
    }) as typeof fs.writeFileSync);

    expect(() => addScheduleRunRequest(home, "daily-brief", new Date("2026-05-10T01:00:00.000Z"))).toThrow(
      "Lost schedule run request lock ownership"
    );
    expect(loadScheduleRunRequests(home)).toEqual([freshRequest]);
    expect(readLockOwner(lockPath)).toBe("fresh-owner");
  });

  it("does nothing when the runtime is stopped", () => {
    const home = tempHome();
    ensureAideHome(home);

    expect(requestScheduleRun(home, "daily-brief")).toBe(false);
    expect(loadScheduleRunRequests(home)).toEqual([]);
  });

  it("signals a running runtime to drain schedule run requests", () => {
    const home = tempHome();
    ensureAideHome(home);
    writeRuntimeState(home, {
      status: "running",
      home,
      pid: 12345
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(requestScheduleRun(home, "daily-brief")).toBe(true);
    expect(loadScheduleRunRequests(home)).toHaveLength(1);
    expect(loadScheduleRunRequests(home)[0]?.scheduleId).toBe("daily-brief");
    expect(kill).toHaveBeenCalledWith(12345, 0);
    expect(kill).toHaveBeenCalledWith(12345, SCHEDULE_RELOAD_SIGNAL);
    expect(fs.readFileSync(path.join(logsDir(home), RUNTIME_LOG_FILE), "utf8")).toContain("schedule_run_requested");
  });
});

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-schedule-run-requests-"));
  cleanupPaths.push(target);
  return target;
}

function writeLock(lockPath: string, owner: string, mtime = new Date("2026-05-10T01:00:00.000Z")): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.mkdirSync(lockPath, { mode: 0o700 });
  fs.writeFileSync(path.join(lockPath, owner), `${owner}\n2026-05-10T01:00:00.000Z\n`, { mode: 0o600 });
  fs.utimesSync(lockPath, mtime, mtime);
}

function replaceLock(lockPath: string, owner: string, mtime = new Date("2026-05-10T01:00:00.000Z")): void {
  fs.rmSync(lockPath, { recursive: true, force: true });
  writeLock(lockPath, owner, mtime);
}

function readLockOwner(lockPath: string): string {
  return fs.readdirSync(lockPath)[0] ?? "";
}
