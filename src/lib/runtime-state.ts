import { displayPath } from "./paths.js";
import { loadRuntimeState, writeRuntimeState } from "./config.js";

export function isPidAlive(pid: number | undefined): boolean {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function markRuntimeRunning(home: string): void {
  writeRuntimeState(home, {
    status: "running",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    home: displayPath(home)
  });
}

export function markRuntimeStopped(home: string): void {
  writeRuntimeState(home, {
    status: "stopped",
    home: displayPath(home)
  });
}

export function runtimeDisplayStatus(home: string): { status: "running" | "stopped"; pid?: number | undefined } {
  const state = loadRuntimeState(home);

  if (state.status === "running" && isPidAlive(state.pid)) {
    return {
      status: "running",
      pid: state.pid
    };
  }

  return { status: "stopped" };
}
