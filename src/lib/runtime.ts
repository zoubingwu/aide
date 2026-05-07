import { spawn } from "node:child_process";
import { loadEndpoints } from "./config.js";
import { appendRuntimeLog } from "./logging.js";
import { markRuntimeRunning, markRuntimeStopped, runtimeDisplayStatus, isPidAlive } from "./runtime-state.js";
import { startDiscordEndpoint } from "./discord.js";
import { RuntimeScheduler } from "./scheduler.js";
import { SCHEDULE_RELOAD_SIGNAL } from "./schedule-reload.js";
import { assertEndpointWorkspace } from "./workspace.js";
import type { Client } from "discord.js";

const START_WAIT_MS = 3_000;

export async function startRuntimeInBackground(home: string): Promise<void> {
  const endpoints = loadEndpoints(home).filter((endpoint) => endpoint.enabled);
  const current = runtimeDisplayStatus(home);

  if (current.status === "running") {
    throw new Error(`Aide is already running with PID ${current.pid}.`);
  }

  if (endpoints.length === 0) {
    console.log("No enabled endpoints. Add one with `aide endpoint add discord --id <id> --token <token>`.");
    return;
  }

  const scriptPath = process.argv[1];

  if (!scriptPath) {
    throw new Error("Cannot resolve current CLI path for background runtime.");
  }

  const child = spawn(process.execPath, [scriptPath, "__run", "--home", home], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  const childExit: {
    exited: boolean;
    code?: number | null;
    signal?: NodeJS.Signals | null;
    error?: string;
  } = { exited: false };

  child.once("exit", (code, signal) => {
    childExit.exited = true;
    childExit.code = code;
    childExit.signal = signal;
  });

  child.once("error", (error) => {
    childExit.exited = true;
    childExit.error = error.message;
  });

  child.unref();
  appendRuntimeLog(home, "runtime_background_start_requested", { pid: child.pid });

  const result = await waitForRuntimeStart(
    home,
    child.pid,
    START_WAIT_MS,
    () => childExit.exited
  );

  if (result === "started") {
    console.log(`Aide runtime started in background with PID ${child.pid}.`);
    return;
  }

  if (result === "exited" || !isPidAlive(child.pid)) {
    appendRuntimeLog(home, "runtime_background_start_failed", {
      pid: child.pid,
      exitCode: childExit.code,
      signal: childExit.signal,
      error: childExit.error
    });
    const detail = childExit.error ?? exitDetail(childExit.code, childExit.signal);
    const message = detail
      ? `Aide runtime failed to start: ${detail}. Run \`aide logs\` for details.`
      : "Aide runtime failed to start. Run `aide logs` for details.";
    throw new Error(message);
  }

  console.log(`Aide runtime is starting in background with PID ${child.pid}. Run \`aide status\` to check it.`);
}

export async function startRuntime(home: string): Promise<void> {
  const endpoints = loadEndpoints(home).filter((endpoint) => endpoint.enabled);
  const current = runtimeDisplayStatus(home);

  if (current.status === "running") {
    throw new Error(`Aide is already running with PID ${current.pid}.`);
  }

  if (endpoints.length === 0) {
    console.log("No enabled endpoints. Add one with `aide endpoint add discord --id <id> --token <token>`.");
    return;
  }

  for (const endpoint of endpoints) {
    assertEndpointWorkspace(home, endpoint);
  }

  appendRuntimeLog(home, "runtime_starting", {
    pid: process.pid,
    agents: endpoints.map((endpoint) => ({
      endpoint: endpoint.id,
      provider: endpoint.agent.provider,
      command: endpoint.agent.command
    }))
  });

  const clients = new Map<string, Client>();
  let scheduler: RuntimeScheduler | undefined;

  try {
    for (const endpoint of endpoints) {
      if (endpoint.provider === "discord") {
        clients.set(endpoint.id, await startDiscordEndpoint(home, endpoint));
        console.log(`Discord endpoint ${endpoint.id} connected.`);
      }
    }
  } catch (error) {
    markRuntimeStopped(home);
    appendRuntimeLog(home, "runtime_start_failed", { error: errorMessage(error) });
    throw error;
  }

  scheduler = new RuntimeScheduler({ home, endpoints, clients });
  scheduler.start();
  const reloadSchedules = () => {
    appendRuntimeLog(home, "schedule_reload_signal", { pid: process.pid });
    scheduler?.reload();
  };
  process.on(SCHEDULE_RELOAD_SIGNAL, reloadSchedules);
  markRuntimeRunning(home);
  appendRuntimeLog(home, "runtime_started", { pid: process.pid, endpoints: endpoints.map((endpoint) => endpoint.id) });
  console.log(`Aide runtime started with PID ${process.pid}. Press Ctrl+C to stop.`);

  await new Promise<void>((resolve) => {
    const stop = async () => {
      appendRuntimeLog(home, "runtime_stopping", { pid: process.pid });
      process.off(SCHEDULE_RELOAD_SIGNAL, reloadSchedules);
      scheduler?.stop();

      for (const client of clients.values()) {
        client.destroy();
      }

      markRuntimeStopped(home);
      appendRuntimeLog(home, "runtime_stopped", { pid: process.pid });
      resolve();
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export function stopRuntime(home: string): void {
  const current = runtimeDisplayStatus(home);

  if (current.status === "stopped" || !current.pid) {
    markRuntimeStopped(home);
    console.log("Aide runtime is stopped.");
    return;
  }

  if (current.pid === process.pid) {
    markRuntimeStopped(home);
    console.log("Aide runtime is stopped.");
    return;
  }

  process.kill(current.pid, "SIGTERM");
  appendRuntimeLog(home, "runtime_stop_requested", { pid: current.pid });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isPidAlive(current.pid)) {
      markRuntimeStopped(home);
      console.log(`Stopped Aide runtime PID ${current.pid}.`);
      return;
    }

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }

  console.log(`Stop signal sent to Aide runtime PID ${current.pid}.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exitDetail(code: number | null | undefined, signal: NodeJS.Signals | null | undefined): string | undefined {
  if (code !== undefined && code !== null) {
    return `child exited with code ${code}`;
  }

  if (signal) {
    return `child exited from signal ${signal}`;
  }

  return undefined;
}

async function waitForRuntimeStart(
  home: string,
  pid: number | undefined,
  timeoutMs: number,
  hasExited: () => boolean
): Promise<"started" | "exited" | "timeout"> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const current = runtimeDisplayStatus(home);

    if (current.status === "running" && current.pid === pid) {
      return "started";
    }

    if (hasExited()) {
      return "exited";
    }

    await sleep(100);
  }

  return "timeout";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
