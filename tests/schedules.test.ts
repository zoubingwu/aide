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
  loadRuntimeSchedules,
  pauseSchedule,
  removeRuntimeSchedule,
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

  it("rejects schedules with invalid timezones", () => {
    const home = tempHome();
    ensureAideHome(home);
    fs.writeFileSync(
      schedulesPath(home),
      `[[schedules]]
id = "bad-timezone"
endpoint = "discord-main"
enabled = true
kind = "daily"
time = "09:00"
timezone = "Europe/Lnodon"
target = "channel:123"
message = "Generate my daily brief."
`
    );

    expect(() => loadSchedules(home)).toThrow("Invalid IANA timezone");
  });

  it("rejects schedules with unsupported targets", () => {
    const home = tempHome();
    ensureAideHome(home);

    expect(() =>
      addSchedule(home, {
        id: "bad-target",
        endpoint: "discord-main",
        enabled: true,
        kind: "daily",
        time: "09:00",
        timezone: "Asia/Shanghai",
        target: "not-a-discord-target",
        message: "Generate my daily brief."
      })
    ).toThrow("Unsupported schedule target");
  });

  it("rejects schedules with duplicate ids", () => {
    const home = tempHome();
    ensureAideHome(home);
    fs.writeFileSync(
      schedulesPath(home),
      `[[schedules]]
id = "daily-brief"
endpoint = "discord-main"
enabled = true
kind = "daily"
time = "09:00"
timezone = "Asia/Shanghai"
target = "channel:123"
message = "Generate my daily brief."

[[schedules]]
id = "daily-brief"
endpoint = "discord-main"
enabled = true
kind = "daily"
time = "10:00"
timezone = "Asia/Shanghai"
target = "channel:456"
message = "Generate my second brief."
`
    );

    expect(() => loadSchedules(home)).toThrow("Duplicate schedule id: daily-brief");
  });

  it("rejects biweekly schedules with invalid start dates", () => {
    const home = tempHome();
    ensureAideHome(home);

    expect(() =>
      addSchedule(home, {
        id: "bad-biweekly",
        endpoint: "discord-main",
        enabled: true,
        kind: "biweekly",
        weekday: "monday",
        startDate: "2026-02-31",
        time: "09:00",
        timezone: "Asia/Shanghai",
        target: "channel:123",
        message: "Generate my biweekly brief."
      })
    ).toThrow("Invalid calendar date");
  });

  it("rejects biweekly schedules with mismatched weekdays", () => {
    const home = tempHome();
    ensureAideHome(home);
    fs.writeFileSync(
      schedulesPath(home),
      `[[schedules]]
id = "bad-biweekly"
endpoint = "discord-main"
enabled = true
kind = "biweekly"
weekday = "monday"
startDate = "2026-05-05"
time = "09:00"
timezone = "Asia/Shanghai"
target = "channel:123"
message = "Generate my biweekly brief."
`
    );

    expect(() => loadSchedules(home)).toThrow("Biweekly startDate must match weekday");
  });

  it("loads valid runtime schedules and reports invalid ones", () => {
    const home = tempHome();
    ensureAideHome(home);
    fs.writeFileSync(
      schedulesPath(home),
      `[[schedules]]
id = "daily-brief"
endpoint = "discord-main"
enabled = true
kind = "daily"
time = "09:00"
timezone = "Asia/Shanghai"
target = "channel:123"
message = "Generate my daily brief."

[[schedules]]
id = "bad-timezone"
endpoint = "discord-main"
enabled = true
kind = "daily"
time = "09:00"
timezone = "Europe/Lnodon"
target = "channel:123"
message = "Generate my daily brief."
`
    );

    expect(loadRuntimeSchedules(home)).toMatchObject({
      schedules: [{ id: "daily-brief" }],
      issues: [{ index: 1, id: "bad-timezone", error: expect.stringContaining("Invalid IANA timezone") }]
    });
  });

  it("reports invalid biweekly anchors during runtime load", () => {
    const home = tempHome();
    ensureAideHome(home);
    fs.writeFileSync(
      schedulesPath(home),
      `[[schedules]]
id = "bad-biweekly"
endpoint = "discord-main"
enabled = true
kind = "biweekly"
weekday = "monday"
startDate = "2026-05-05"
time = "09:00"
timezone = "Asia/Shanghai"
target = "channel:123"
message = "Generate my biweekly brief."
`
    );

    expect(loadRuntimeSchedules(home)).toMatchObject({
      schedules: [],
      issues: [{ index: 0, id: "bad-biweekly", error: expect.stringContaining("Biweekly startDate must match weekday") }]
    });
  });

  it("reports unsupported targets during runtime load", () => {
    const home = tempHome();
    ensureAideHome(home);
    fs.writeFileSync(
      schedulesPath(home),
      `[[schedules]]
id = "bad-target"
endpoint = "discord-main"
enabled = true
kind = "daily"
time = "09:00"
timezone = "Asia/Shanghai"
target = "not-a-discord-target"
message = "Generate my daily brief."
`
    );

    expect(loadRuntimeSchedules(home)).toMatchObject({
      schedules: [],
      issues: [{ index: 0, id: "bad-target", error: expect.stringContaining("Unsupported schedule target") }]
    });
  });

  it("reports duplicate schedule ids during runtime load", () => {
    const home = tempHome();
    ensureAideHome(home);
    fs.writeFileSync(
      schedulesPath(home),
      `[[schedules]]
id = "daily-brief"
endpoint = "discord-main"
enabled = true
kind = "daily"
time = "09:00"
timezone = "Asia/Shanghai"
target = "channel:123"
message = "Generate my daily brief."

[[schedules]]
id = "daily-brief"
endpoint = "discord-main"
enabled = true
kind = "daily"
time = "10:00"
timezone = "Asia/Shanghai"
target = "channel:456"
message = "Generate my second brief."
`
    );

    expect(loadRuntimeSchedules(home)).toMatchObject({
      schedules: [{ id: "daily-brief", time: "09:00" }],
      issues: [{ index: 1, id: "daily-brief", error: "Duplicate schedule id: daily-brief" }]
    });
  });

  it("removes a runtime schedule while preserving invalid peer entries", () => {
    const home = tempHome();
    ensureAideHome(home);
    fs.writeFileSync(
      schedulesPath(home),
      `[[schedules]]
id = "pay-rent"
endpoint = "discord-main"
enabled = true
kind = "once"
runAt = "2026-05-10T10:00:00+08:00"
target = "user:987"
message = "Remind me to pay rent."

[[schedules]]
id = "bad-timezone"
endpoint = "discord-main"
enabled = true
kind = "daily"
time = "09:00"
timezone = "Europe/Lnodon"
target = "channel:123"
message = "Generate my daily brief."
`
    );

    removeRuntimeSchedule(home, "pay-rent");

    const content = fs.readFileSync(schedulesPath(home), "utf8");
    expect(content).not.toContain('id = "pay-rent"');
    expect(content).toContain('id = "bad-timezone"');
    expect(loadRuntimeSchedules(home)).toMatchObject({
      schedules: [],
      issues: [{ id: "bad-timezone" }]
    });
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
