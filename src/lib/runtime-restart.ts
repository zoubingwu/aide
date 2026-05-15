import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { appendRuntimeLog } from "./logging.js";
import { deferredRestartPath } from "./paths.js";

export const DEFER_RUNTIME_RESTART_ENV = "AIDE_DEFER_RUNTIME_RESTART";
export const DEFER_RUNTIME_RESTART_HOME_ENV = "AIDE_DEFER_RUNTIME_RESTART_HOME";

interface DeferredRestartRequest {
  requestedAt: string;
  pid: number;
}

export function deferredRestartEnv(home: string): Record<string, string> {
  return {
    [DEFER_RUNTIME_RESTART_ENV]: "1",
    [DEFER_RUNTIME_RESTART_HOME_ENV]: home
  };
}

export function shouldDeferRuntimeRestart(home: string): boolean {
  const mode = process.env[DEFER_RUNTIME_RESTART_ENV];
  const envHome = process.env[DEFER_RUNTIME_RESTART_HOME_ENV];

  if (mode !== "1" || !envHome) {
    return false;
  }

  return path.resolve(envHome) === path.resolve(home);
}

export function requestDeferredRuntimeRestart(home: string): void {
  const request: DeferredRestartRequest = {
    requestedAt: new Date().toISOString(),
    pid: process.pid
  };
  const file = deferredRestartPath(home);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  appendRuntimeLog(home, "runtime_restart_deferred", {
    requestedAt: request.requestedAt,
    pid: request.pid
  });
}

export function consumeDeferredRuntimeRestart(home: string): boolean {
  const file = deferredRestartPath(home);

  if (!fs.existsSync(file)) {
    return false;
  }

  fs.rmSync(file, { force: true });
  appendRuntimeLog(home, "runtime_restart_deferred_consumed", { pid: process.pid });
  return true;
}

export function clearDeferredRuntimeRestart(home: string): void {
  fs.rmSync(deferredRestartPath(home), { force: true });
}

export function startDeferredRuntimeRestart(home: string): void {
  const scriptPath = process.argv[1];

  if (!scriptPath) {
    appendRuntimeLog(home, "runtime_restart_deferred_failed", { error: "Cannot resolve current CLI path." });
    return;
  }

  const env = restartEnv();
  const child = spawn(process.execPath, [scriptPath, "--home", home, "restart"], {
    detached: true,
    stdio: "ignore",
    env
  });

  child.unref();
  appendRuntimeLog(home, "runtime_restart_deferred_started", { pid: child.pid });
}

function restartEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[DEFER_RUNTIME_RESTART_ENV];
  delete env[DEFER_RUNTIME_RESTART_HOME_ENV];
  return env;
}
