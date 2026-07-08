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
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "stale\n");
    const staleAt = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleAt, staleAt);

    const request = addScheduleRunRequest(home, "daily-brief", new Date("2026-05-10T01:00:00.000Z"));

    expect(loadScheduleRunRequests(home)).toEqual([request]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("keeps a fresh request lock that replaces a stale lock during recovery", () => {
    const home = tempHome();
    ensureAideHome(home);
    const lockPath = `${scheduleRunRequestsPath(home)}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "stale\n");
    fs.utimesSync(lockPath, new Date(0), new Date(0));
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
          fs.rmSync(lockPath, { force: true });
          fs.writeFileSync(lockPath, "fresh\n");
          fs.utimesSync(lockPath, new Date(60_000), new Date(60_000));
        }
      }

      return stat;
    }) as typeof fs.statSync);

    expect(() => addScheduleRunRequest(home, "daily-brief", new Date("2026-05-10T01:00:00.000Z"))).toThrow(
      "Timed out waiting for schedule run request lock"
    );
    expect(fs.readFileSync(lockPath, "utf8")).toBe("fresh\n");
    expect(loadScheduleRunRequests(home)).toEqual([]);
  });

  it("leaves stale lock cleanup to the active cleanup owner", () => {
    const home = tempHome();
    ensureAideHome(home);
    const lockPath = `${scheduleRunRequestsPath(home)}.lock`;
    const cleanupLockPath = `${lockPath}.cleanup`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "stale\n");
    fs.writeFileSync(cleanupLockPath, "cleanup-owner\n");
    fs.utimesSync(lockPath, new Date(0), new Date(0));
    vi.spyOn(Date, "now").mockReturnValueOnce(60_000).mockReturnValue(62_001);

    expect(() => addScheduleRunRequest(home, "daily-brief", new Date("2026-05-10T01:00:00.000Z"))).toThrow(
      "Timed out waiting for schedule run request lock"
    );
    expect(fs.readFileSync(lockPath, "utf8")).toBe("stale\n");
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

      if (!replaced) {
        replaced = true;
        fs.rmSync(lockPath, { force: true });
        fs.writeFileSync(lockPath, "fresh-owner\n2026-05-10T01:00:00.000Z\n");
      }
    });

    const request = addScheduleRunRequest(home, "daily-brief", new Date("2026-05-10T01:00:00.000Z"));

    expect(loadScheduleRunRequests(home)).toEqual([request]);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("fresh-owner\n2026-05-10T01:00:00.000Z\n");
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
        fs.rmSync(lockPath, { force: true });
        writeFileSync(lockPath, "fresh-owner\n2026-05-10T02:00:00.000Z\n");
        writeFileSync(filePath, `${JSON.stringify({ requests: [freshRequest] }, null, 2)}\n`, { mode: 0o600 });
      }
    }) as typeof fs.writeFileSync);

    expect(() => addScheduleRunRequest(home, "daily-brief", new Date("2026-05-10T01:00:00.000Z"))).toThrow(
      "Lost schedule run request lock ownership"
    );
    expect(loadScheduleRunRequests(home)).toEqual([freshRequest]);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("fresh-owner\n2026-05-10T02:00:00.000Z\n");
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
