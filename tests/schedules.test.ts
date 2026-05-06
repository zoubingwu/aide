import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAideHome } from "../src/lib/config.js";
import { schedulesPath } from "../src/lib/paths.js";
import {
  addSchedule,
  findSchedule,
  loadSchedules,
  pauseSchedule,
  removeSchedule,
  resumeSchedule,
  writeSchedules
} from "../src/lib/schedules.js";
import type { Schedule } from "../src/lib/types.js";

const cleanupPaths: string[] = [];

describe("schedules", () => {
  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("loads an empty schedules file", () => {
    const home = tempHome();
    ensureAideHome(home);

    expect(loadSchedules(home)).toEqual([]);
  });

  it("writes and loads schedules", () => {
    const home = tempHome();
    ensureAideHome(home);
    const schedule: Schedule = {
      id: "daily-brief",
      endpoint: "discord-main",
      enabled: true,
      kind: "daily",
      time: "09:00",
      timezone: "Asia/Shanghai",
      target: "channel:123",
      message: "Generate my daily brief."
    };

    writeSchedules(home, [schedule]);

    expect(loadSchedules(home)).toEqual([schedule]);
    expect(fs.readFileSync(schedulesPath(home), "utf8")).toContain('id = "daily-brief"');
  });

  it("rejects schedules with missing fields", () => {
    const home = tempHome();
    ensureAideHome(home);
    fs.writeFileSync(
      schedulesPath(home),
      `[[schedules]]
id = "bad"
endpoint = "discord-main"
enabled = true
kind = "daily"
timezone = "Asia/Shanghai"
target = "channel:123"
message = "Generate my daily brief."
`
    );

    expect(() => loadSchedules(home)).toThrow();
  });

  it("adds, finds, pauses, resumes, and removes a schedule", () => {
    const home = tempHome();
    ensureAideHome(home);
    const schedule: Schedule = {
      id: "pay-rent",
      endpoint: "discord-main",
      enabled: true,
      kind: "once",
      runAt: "2026-05-10T10:00:00+08:00",
      target: "user:987",
      message: "Remind me to pay rent."
    };

    addSchedule(home, schedule);
    expect(findSchedule(home, "pay-rent")).toEqual(schedule);

    pauseSchedule(home, "pay-rent");
    expect(findSchedule(home, "pay-rent").enabled).toBe(false);

    resumeSchedule(home, "pay-rent");
    expect(findSchedule(home, "pay-rent").enabled).toBe(true);

    removeSchedule(home, "pay-rent");
    expect(loadSchedules(home)).toEqual([]);
  });
});

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-schedules-"));
  cleanupPaths.push(target);
  return target;
}
