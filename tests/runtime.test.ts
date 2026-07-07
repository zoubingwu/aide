import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCodexAgentConfig, defaultEndpointTriggerConfig, ensureAideHome, writeEndpoints } from "../src/lib/config.js";
import { startRuntime } from "../src/lib/runtime.js";
import type { Endpoint } from "../src/lib/types.js";

const mocks = vi.hoisted(() => {
  const schedulerInstances: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    runRequestedSchedules: ReturnType<typeof vi.fn>;
    retryPendingDeliveries: ReturnType<typeof vi.fn>;
  }> = [];
  const client = {
    on: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn()
  };

  return {
    client,
    schedulerInstances,
    startDiscordEndpoint: vi.fn(async () => client)
  };
});

vi.mock("../src/lib/discord.js", () => ({
  startDiscordEndpoint: mocks.startDiscordEndpoint
}));

vi.mock("../src/lib/scheduler.js", () => ({
  RuntimeScheduler: class {
    start = vi.fn();
    stop = vi.fn();
    runRequestedSchedules = vi.fn();
    retryPendingDeliveries = vi.fn();

    constructor() {
      mocks.schedulerInstances.push(this);
    }
  }
}));

vi.mock("../src/lib/workspace.js", () => ({
  assertEndpointWorkspace: vi.fn()
}));

const cleanupPaths: string[] = [];
const processEvents = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection", "exit"] as const;
let previousProcessListeners = new Map<(typeof processEvents)[number], Function[]>();

describe("runtime", () => {
  beforeEach(() => {
    previousProcessListeners = new Map(processEvents.map((event) => [event, process.listeners(event)]));
  });

  afterEach(() => {
    removeAddedProcessListeners();
    vi.restoreAllMocks();
    mocks.client.on.mockClear();
    mocks.client.off.mockClear();
    mocks.client.destroy.mockClear();
    mocks.startDiscordEndpoint.mockClear();
    mocks.schedulerInstances.splice(0);

    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("drains queued manual schedule runs after scheduler startup", async () => {
    const home = tempHome();
    ensureAideHome(home);
    writeEndpoints(home, [discordEndpoint()]);
    const runtime = startRuntime(home);

    await waitFor(() => expect(mocks.schedulerInstances[0]?.runRequestedSchedules).toHaveBeenCalledTimes(1));
    process.emit("SIGTERM");
    await runtime;

    const scheduler = mocks.schedulerInstances[0];
    expect(scheduler?.start).toHaveBeenCalledTimes(1);
    expect(scheduler?.runRequestedSchedules).toHaveBeenCalledTimes(1);
    expect(scheduler?.stop).toHaveBeenCalledTimes(1);
  });
});

function removeAddedProcessListeners(): void {
  for (const event of processEvents) {
    const previous = previousProcessListeners.get(event) ?? [];

    for (const listener of process.listeners(event)) {
      if (!previous.includes(listener)) {
        process.removeListener(event, listener);
      }
    }
  }
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
}

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-runtime-"));
  cleanupPaths.push(target);
  return target;
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
