import { loadConfig, loadEndpoints } from "./config.js";
import { appendRuntimeLog } from "./logging.js";
import { markRuntimeRunning, markRuntimeStopped, runtimeDisplayStatus, isPidAlive } from "./runtime-state.js";
import { startDiscordEndpoint } from "./discord.js";
import { assertEndpointWorkspace } from "./workspace.js";
import type { Client } from "discord.js";

export async function startRuntime(home: string): Promise<void> {
  const config = loadConfig(home);
  const endpoints = loadEndpoints(home).filter((endpoint) => endpoint.enabled);
  const current = runtimeDisplayStatus(home);

  if (current.status === "running") {
    throw new Error(`Aide is already running with PID ${current.pid}.`);
  }

  if (endpoints.length === 0) {
    console.log("No enabled endpoints. Add one with `aide endpoint add discord`.");
    return;
  }

  for (const endpoint of endpoints) {
    assertEndpointWorkspace(endpoint);
  }

  markRuntimeRunning(home);
  appendRuntimeLog(home, "runtime_starting", { pid: process.pid, command: config.runtime.command });

  const clients: Client[] = [];

  try {
    for (const endpoint of endpoints) {
      if (endpoint.provider === "discord") {
        clients.push(await startDiscordEndpoint(home, endpoint));
        console.log(`Discord endpoint ${endpoint.id} connected.`);
      }
    }
  } catch (error) {
    markRuntimeStopped(home);
    appendRuntimeLog(home, "runtime_start_failed", { error: errorMessage(error) });
    throw error;
  }

  appendRuntimeLog(home, "runtime_started", { pid: process.pid, endpoints: endpoints.map((endpoint) => endpoint.id) });
  console.log(`Aide runtime started with PID ${process.pid}. Press Ctrl+C to stop.`);

  await new Promise<void>((resolve) => {
    const stop = async () => {
      appendRuntimeLog(home, "runtime_stopping", { pid: process.pid });

      for (const client of clients) {
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
