import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAideHome, writeEndpoints } from "../src/lib/config.js";
import { executeScheduleOnce } from "../src/lib/scheduler.js";
import { loadSchedules, writeSchedules } from "../src/lib/schedules.js";
import type { Endpoint, Schedule } from "../src/lib/types.js";

const cleanupPaths: string[] = [];

describe("scheduler execution", () => {
  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("removes a once schedule after successful agent and delivery", async () => {
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = discordEndpoint();
    const schedule = onceSchedule();
    writeEndpoints(home, [endpoint]);
    writeSchedules(home, [schedule]);

    await executeScheduleOnce({
      home,
      schedule,
      endpoints: [endpoint],
      clients: new Map([["discord-main", {}]]),
      handleRequest: vi.fn().mockResolvedValue({ response: "done", stdout: "", stderr: "", exitCode: 0, resumed: true }),
      deliver: vi.fn().mockResolvedValue(undefined)
    });

    expect(loadSchedules(home)).toEqual([]);
  });

  it("keeps a once schedule after delivery failure", async () => {
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = discordEndpoint();
    const schedule = onceSchedule();
    writeEndpoints(home, [endpoint]);
    writeSchedules(home, [schedule]);

    await executeScheduleOnce({
      home,
      schedule,
      endpoints: [endpoint],
      clients: new Map([["discord-main", {}]]),
      handleRequest: vi.fn().mockResolvedValue({ response: "done", stdout: "", stderr: "", exitCode: 0, resumed: true }),
      deliver: vi.fn().mockRejectedValue(new Error("send failed"))
    });

    expect(loadSchedules(home)).toEqual([schedule]);
  });

  it("skips schedules that reference disabled endpoints", async () => {
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = { ...discordEndpoint(), enabled: false };
    const schedule = onceSchedule();
    const handleRequest = vi.fn();
    writeEndpoints(home, [endpoint]);
    writeSchedules(home, [schedule]);

    await executeScheduleOnce({
      home,
      schedule,
      endpoints: [endpoint],
      clients: new Map([["discord-main", {}]]),
      handleRequest,
      deliver: vi.fn()
    });

    expect(handleRequest).toHaveBeenCalledTimes(0);
  });
});

function discordEndpoint(): Endpoint {
  return { id: "discord-main", provider: "discord", enabled: true };
}

function onceSchedule(): Schedule {
  return {
    id: "pay-rent",
    endpoint: "discord-main",
    enabled: true,
    kind: "once",
    runAt: "2026-05-10T10:00:00+08:00",
    target: "user:987",
    message: "Remind me to pay rent."
  };
}

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-scheduler-"));
  cleanupPaths.push(target);
  return target;
}
