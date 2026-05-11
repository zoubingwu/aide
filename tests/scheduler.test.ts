import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCodexAgentConfig, defaultEndpointTriggerConfig, ensureAideHome, writeEndpoints } from "../src/lib/config.js";
import { loadPendingDeliveries } from "../src/lib/delivery-retries.js";
import { RUNTIME_LOG_FILE } from "../src/lib/logging.js";
import { logsDir, schedulesPath } from "../src/lib/paths.js";
import { executeScheduleOnce, RuntimeScheduler } from "../src/lib/scheduler.js";
import { loadSchedules, writeSchedules } from "../src/lib/schedules.js";
import type { AgentRunResult, Endpoint, Schedule } from "../src/lib/types.js";

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
      handleRequest: vi.fn().mockResolvedValue(agentResult({ response: "done" })),
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
      handleRequest: vi.fn().mockResolvedValue(agentResult({ response: "done" })),
      deliver: vi.fn().mockResolvedValue(undefined)
    });

    const content = fs.readFileSync(schedulesPath(home), "utf8");
    expect(content).not.toContain('"id": "pay-rent"');
    expect(content).toContain('"id": "bad-timezone"');
  });

  it("queues a once schedule after delivery failure without keeping the schedule", async () => {
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
      handleRequest: vi.fn().mockResolvedValue(agentResult({ response: "done" })),
      deliver: vi.fn().mockRejectedValue(new Error("send failed"))
    });

    expect(loadSchedules(home)).toEqual([]);
    expect(loadPendingDeliveries(home)).toMatchObject([
      {
        scheduleId: schedule.id,
        endpoint: endpoint.id,
        target: schedule.target,
        response: "done",
        attempts: 1,
        lastError: "send failed"
      }
    ]);
  });

  it("does not queue invalid delivery targets", async () => {
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
      handleRequest: vi.fn().mockResolvedValue(agentResult({ response: "done" })),
      deliver: vi.fn().mockRejectedValue(new Error("Unsupported Discord target: thread:456"))
    });

    const log = fs.readFileSync(path.join(logsDir(home), RUNTIME_LOG_FILE), "utf8");
    expect(log).toContain("schedule_delivery_invalid");
    expect(log).not.toContain("schedule_delivery_queued");
    expect(loadPendingDeliveries(home)).toEqual([]);
    expect(loadSchedules(home)).toEqual([]);
  });

  it("removes a once schedule after successful agent run with no text response", async () => {
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = discordEndpoint();
    const schedule = onceSchedule();
    const deliver = vi.fn();
    writeEndpoints(home, [endpoint]);
    writeSchedules(home, [schedule]);

    await executeScheduleOnce({
      home,
      schedule,
      endpoints: [endpoint],
      clients: new Map([["discord-main", {}]]),
      handleRequest: vi.fn().mockResolvedValue(agentResult({ response: "", hasTextResponse: false })),
      deliver
    });

    expect(deliver).not.toHaveBeenCalled();
    expect(loadSchedules(home)).toEqual([]);
    expect(fs.readFileSync(path.join(logsDir(home), RUNTIME_LOG_FILE), "utf8")).toContain("schedule_response_empty");
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

  it("retries recurring schedules after agent failures", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-10T10:00:00.000Z") });
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = discordEndpoint();
    const schedule = dailySchedule();
    const handleRequest = vi.fn()
      .mockResolvedValueOnce(agentResult({ exitCode: 1, response: "network unavailable" }))
      .mockResolvedValueOnce(agentResult({ response: "done" }));
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
    const run = bindRun(scheduler);

    await run(schedule);
    expect(handleRequest).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(handleRequest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(handleRequest).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledWith(endpoint, {}, schedule.target, "done");

    const log = fs.readFileSync(path.join(logsDir(home), RUNTIME_LOG_FILE), "utf8");
    expect(log).toContain("schedule_retry_scheduled");
    expect(log).toContain("network unavailable");
    scheduler.stop();
  });

  it("retries pending delivery without rerunning the agent", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-10T10:00:00.000Z") });
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = discordEndpoint();
    const schedule = dailySchedule();
    const handleRequest = vi.fn().mockResolvedValue(agentResult({ response: "daily brief" }));
    const deliver = vi.fn()
      .mockRejectedValueOnce(new Error("discord network down"))
      .mockResolvedValueOnce(undefined);
    writeEndpoints(home, [endpoint]);
    writeSchedules(home, [schedule]);

    const scheduler = new RuntimeScheduler({
      home,
      endpoints: [endpoint],
      clients: new Map([["discord-main", {} as never]]),
      handleRequest,
      deliver
    });
    const run = bindRun(scheduler);

    await run(schedule);
    expect(handleRequest).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(loadPendingDeliveries(home)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(handleRequest).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);

    await scheduler.retryPendingDeliveries({ force: true });

    expect(handleRequest).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(endpoint, {}, schedule.target, "daily brief");
    expect(loadPendingDeliveries(home)).toEqual([]);
    scheduler.stop();
  });

  it("loads pending deliveries after restart and retries due deliveries", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-10T10:00:00.000Z") });
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = discordEndpoint();
    const schedule = dailySchedule();
    const firstDeliver = vi.fn().mockRejectedValueOnce(new Error("discord network down"));
    writeEndpoints(home, [endpoint]);
    writeSchedules(home, [schedule]);

    const firstScheduler = new RuntimeScheduler({
      home,
      endpoints: [endpoint],
      clients: new Map([["discord-main", {} as never]]),
      handleRequest: vi.fn().mockResolvedValue(agentResult({ response: "daily brief" })),
      deliver: firstDeliver
    });
    await bindRun(firstScheduler)(schedule);
    firstScheduler.stop();
    expect(loadPendingDeliveries(home)).toHaveLength(1);

    const secondDeliver = vi.fn().mockResolvedValue(undefined);
    const secondScheduler = new RuntimeScheduler({
      home,
      endpoints: [endpoint],
      clients: new Map([["discord-main", {} as never]]),
      handleRequest: vi.fn(),
      deliver: secondDeliver
    });

    await secondScheduler.retryPendingDeliveries({ force: true });

    expect(secondDeliver).toHaveBeenCalledWith(endpoint, {}, schedule.target, "daily brief");
    expect(loadPendingDeliveries(home)).toEqual([]);
    secondScheduler.stop();
  });

  it("stops recurring retries after the retry limit", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-10T10:00:00.000Z") });
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = discordEndpoint();
    const schedule = dailySchedule();
    const handleRequest = vi.fn().mockResolvedValue(agentResult({ exitCode: 1 }));
    writeEndpoints(home, [endpoint]);
    writeSchedules(home, [schedule]);

    const scheduler = new RuntimeScheduler({
      home,
      endpoints: [endpoint],
      clients: new Map([["discord-main", {} as never]]),
      handleRequest,
      deliver: vi.fn()
    });
    const run = bindRun(scheduler);

    await run(schedule);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(handleRequest).toHaveBeenCalledTimes(4);
    expect(fs.readFileSync(path.join(logsDir(home), RUNTIME_LOG_FILE), "utf8")).toContain("schedule_retry_exhausted");
    scheduler.stop();
  });

  it("retries failed biweekly occurrences after local midnight", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-04T15:58:00.000Z") });
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = discordEndpoint();
    const schedule = biweeklySchedule();
    const handleRequest = vi.fn()
      .mockResolvedValueOnce(agentResult({ exitCode: 1, response: "network unavailable" }))
      .mockResolvedValueOnce(agentResult({ response: "done" }));
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
    const run = bindRun(scheduler);

    await run(schedule);
    expect(handleRequest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(handleRequest).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledWith(endpoint, {}, schedule.target, "done");
    scheduler.stop();
  });

  it("preserves one-shot agent retry delays across reloads", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-10T10:02:00.000Z") });
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = discordEndpoint();
    const schedule: Schedule = {
      ...onceSchedule(),
      runAt: "2026-05-10T10:00:00.000Z"
    };
    const handleRequest = vi.fn().mockResolvedValue(agentResult({ exitCode: 1, response: "network unavailable" }));
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

    await vi.advanceTimersByTimeAsync(30_000);
    scheduler.reload();
    await vi.advanceTimersByTimeAsync(0);
    expect(handleRequest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(handleRequest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(handleRequest).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledTimes(0);
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
    let resolveRequest: ((value: AgentRunResult) => void) | undefined;
    const handleRequest = vi.fn(
      () =>
        new Promise<AgentRunResult>((resolve) => {
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

    resolveRequest?.(agentResult({ response: "done" }));
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

function agentResult(overrides: Partial<AgentRunResult>): AgentRunResult {
  return {
    response: "done",
    hasTextResponse: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    resumed: true,
    ...overrides
  };
}

function discordEndpoint(): Endpoint {
  return {
    id: "discord-main",
    provider: "discord",
    enabled: true,
    token: "test-token",
    trigger: defaultEndpointTriggerConfig(),
    agent: defaultCodexAgentConfig()
  };
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

function dailySchedule(): Schedule {
  return {
    id: "daily-brief",
    endpoint: "discord-main",
    enabled: true,
    kind: "daily",
    timezone: "Asia/Shanghai",
    time: "09:00",
    target: "channel:123",
    message: "Generate my daily brief."
  };
}

function biweeklySchedule(): Schedule {
  return {
    id: "biweekly-brief",
    endpoint: "discord-main",
    enabled: true,
    kind: "biweekly",
    timezone: "Asia/Shanghai",
    weekday: "monday",
    startDate: "2026-05-04",
    time: "23:58",
    target: "channel:123",
    message: "Generate my biweekly brief."
  };
}

function bindRun(scheduler: RuntimeScheduler): (schedule: Schedule) => Promise<"ran" | "skipped"> {
  return (scheduler as unknown as { run(schedule: Schedule): Promise<"ran" | "skipped"> }).run.bind(scheduler);
}

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-scheduler-"));
  cleanupPaths.push(target);
  return target;
}
