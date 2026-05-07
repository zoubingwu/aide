import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCodexAgentConfig, ensureAideHome, writeEndpoints } from "../src/lib/config.js";
import { RUNTIME_LOG_FILE } from "../src/lib/logging.js";
import { logsDir, schedulesPath } from "../src/lib/paths.js";
import { executeScheduleOnce, RuntimeScheduler } from "../src/lib/scheduler.js";
import { loadSchedules, writeSchedules } from "../src/lib/schedules.js";
import type { Endpoint, Schedule } from "../src/lib/types.js";

const cleanupPaths: string[] = [];

describe("scheduler execution", () => {
  afterEach(() => {
    vi.useRealTimers();

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

  it("removes a delivered once schedule when another entry is invalid", async () => {
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = discordEndpoint();
    const schedule = onceSchedule();
    writeEndpoints(home, [endpoint]);
    fs.writeFileSync(
      schedulesPath(home),
      JSON.stringify(
        {
          schedules: [
            schedule,
            {
              id: "bad-timezone",
              endpoint: "discord-main",
              enabled: true,
              kind: "daily",
              time: "09:00",
              timezone: "Europe/Lnodon",
              target: "channel:123",
              message: "Generate my daily brief."
            }
          ]
        },
        null,
        2
      )
    );

    await executeScheduleOnce({
      home,
      schedule,
      endpoints: [endpoint],
      clients: new Map([["discord-main", {}]]),
      handleRequest: vi.fn().mockResolvedValue({ response: "done", stdout: "", stderr: "", exitCode: 0, resumed: true }),
      deliver: vi.fn().mockResolvedValue(undefined)
    });

    const content = fs.readFileSync(schedulesPath(home), "utf8");
    expect(content).not.toContain('"id": "pay-rent"');
    expect(content).toContain('"id": "bad-timezone"');
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

  it("logs agent request exceptions and keeps the schedule", async () => {
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
      handleRequest: vi.fn().mockRejectedValue(new Error("missing runtime command")),
      deliver: vi.fn()
    });

    const log = fs.readFileSync(path.join(logsDir(home), RUNTIME_LOG_FILE), "utf8");
    expect(log).toContain("schedule_agent_failed");
    expect(log).toContain("missing runtime command");
    expect(loadSchedules(home)).toEqual([schedule]);
  });

  it("preserves one-shot retry delays across reloads", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-10T10:02:00.000Z") });
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = discordEndpoint();
    const schedule: Schedule = {
      ...onceSchedule(),
      runAt: "2026-05-10T10:00:00.000Z"
    };
    const handleRequest = vi.fn().mockResolvedValue({ response: "done", stdout: "", stderr: "", exitCode: 0, resumed: true });
    const deliver = vi.fn().mockRejectedValue(new Error("send failed"));
    writeEndpoints(home, [endpoint]);
    writeSchedules(home, [schedule]);

    const scheduler = new RuntimeScheduler({
      home,
      endpoints: [endpoint],
      clients: new Map([["discord-main", {} as never]]),
      handleRequest,
      deliver
    });

    scheduler.reload();
    await vi.advanceTimersByTimeAsync(0);
    expect(handleRequest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    scheduler.reload();
    await vi.advanceTimersByTimeAsync(0);
    expect(handleRequest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(handleRequest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(handleRequest).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("does not arm a stale one-shot retry when reload skips a running job", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-10T10:02:00.000Z") });
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = discordEndpoint();
    const schedule: Schedule = {
      ...onceSchedule(),
      runAt: "2026-05-10T10:00:00.000Z"
    };
    let resolveRequest: ((value: { response: string; stdout: string; stderr: string; exitCode: number; resumed: boolean }) => void) | undefined;
    const handleRequest = vi.fn(
      () =>
        new Promise<{ response: string; stdout: string; stderr: string; exitCode: number; resumed: boolean }>((resolve) => {
          resolveRequest = resolve;
        })
    );
    const deliver = vi.fn().mockResolvedValue(undefined);
    writeEndpoints(home, [endpoint]);
    writeSchedules(home, [schedule]);

    const scheduler = new RuntimeScheduler({
      home,
      endpoints: [endpoint],
      clients: new Map([["discord-main", {} as never]]),
      handleRequest,
      deliver
    });

    scheduler.reload();
    await vi.advanceTimersByTimeAsync(0);
    expect(handleRequest).toHaveBeenCalledTimes(1);

    scheduler.reload();
    await vi.advanceTimersByTimeAsync(0);
    expect(handleRequest).toHaveBeenCalledTimes(1);

    resolveRequest?.({ response: "done", stdout: "", stderr: "", exitCode: 0, resumed: true });
    await vi.runOnlyPendingTimersAsync();
    expect(loadSchedules(home)).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(handleRequest).toHaveBeenCalledTimes(1);
    scheduler.stop();
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

  it("skips invalid runtime schedule entries during reload", () => {
    const home = tempHome();
    ensureAideHome(home);
    fs.writeFileSync(
      schedulesPath(home),
      JSON.stringify(
        {
          schedules: [
            {
              id: "bad-timezone",
              endpoint: "discord-main",
              enabled: true,
              kind: "daily",
              time: "09:00",
              timezone: "Europe/Lnodon",
              target: "channel:123",
              message: "Generate my daily brief."
            }
          ]
        },
        null,
        2
      )
    );

    const scheduler = new RuntimeScheduler({ home, endpoints: [discordEndpoint()], clients: new Map() });

    expect(() => scheduler.reload()).not.toThrow();

    const log = fs.readFileSync(path.join(logsDir(home), RUNTIME_LOG_FILE), "utf8");
    expect(log).toContain("schedule_invalid");
    expect(log).toContain("Invalid IANA timezone");
  });
});

function discordEndpoint(): Endpoint {
  return { id: "discord-main", provider: "discord", enabled: true, agent: defaultCodexAgentConfig() };
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
