import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { appendRuntimeLog } from "./logging.js";
import { deferredRestartPath } from "./paths.js";

export const DEFER_RUNTIME_RESTART_ENV = "AIDE_DEFER_RUNTIME_RESTART";
export const DEFER_RUNTIME_RESTART_HOME_ENV = "AIDE_DEFER_RUNTIME_RESTART_HOME";
export const DEFER_RUNTIME_RESTART_ID_ENV = "AIDE_DEFER_RUNTIME_RESTART_ID";

interface DeferredRestartRequest {
  id: string;
  requestedAt: string;
  pid: number;
}

interface DeferredRestartFile {
  requests: DeferredRestartRequest[];
}

export function deferredRestartEnv(home: string, id: string): Record<string, string> {
  return {
    [DEFER_RUNTIME_RESTART_ENV]: "1",
    [DEFER_RUNTIME_RESTART_HOME_ENV]: home,
    [DEFER_RUNTIME_RESTART_ID_ENV]: id
  };
}

export function deferredRuntimeRestartId(home: string): string | undefined {
  const mode = process.env[DEFER_RUNTIME_RESTART_ENV];
  const envHome = process.env[DEFER_RUNTIME_RESTART_HOME_ENV];
  const id = process.env[DEFER_RUNTIME_RESTART_ID_ENV];

  if (mode !== "1" || !envHome || !id) {
    return undefined;
  }

  return path.resolve(envHome) === path.resolve(home) ? id : undefined;
}

export function requestDeferredRuntimeRestart(home: string, id: string): void {
  const request: DeferredRestartRequest = {
    id,
    requestedAt: new Date().toISOString(),
    pid: process.pid
  };
  const file = deferredRestartPath(home);
  const requests = loadDeferredRestartRequests(home).filter((candidate) => candidate.id !== id);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeDeferredRestartRequests(file, [...requests, request]);
  appendRuntimeLog(home, "runtime_restart_deferred", {
    id: request.id,
    requestedAt: request.requestedAt,
    pid: request.pid
  });
}

export function consumeDeferredRuntimeRestart(home: string, id: string): boolean {
  const file = deferredRestartPath(home);
  const requests = loadDeferredRestartRequests(home);
  const matched = requests.some((request) => request.id === id);

  if (!matched) {
    return false;
  }

  const remaining = requests.filter((request) => request.id !== id);

  if (remaining.length === 0) {
    fs.rmSync(file, { force: true });
  } else {
    writeDeferredRestartRequests(file, remaining);
  }

  appendRuntimeLog(home, "runtime_restart_deferred_consumed", { id, pid: process.pid });
  return true;
}

export function clearDeferredRuntimeRestart(home: string, id: string): void {
  const file = deferredRestartPath(home);
  const remaining = loadDeferredRestartRequests(home).filter((request) => request.id !== id);

  if (remaining.length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }

  writeDeferredRestartRequests(file, remaining);
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
  delete env[DEFER_RUNTIME_RESTART_ID_ENV];
  return env;
}

function loadDeferredRestartRequests(home: string): DeferredRestartRequest[] {
  const file = deferredRestartPath(home);

  if (!fs.existsSync(file)) {
    return [];
  }

  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as DeferredRestartFile;
  return Array.isArray(parsed.requests) ? parsed.requests : [];
}

function writeDeferredRestartRequests(file: string, requests: DeferredRestartRequest[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ requests }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
