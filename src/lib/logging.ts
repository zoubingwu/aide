import fs from "node:fs";
import path from "node:path";
import { endpointWorkspacePath, logsDir } from "./paths.js";
import type { Endpoint } from "./types.js";

export const RUNTIME_LOG_FILE = "runtime.log";
export const ACTIVITY_LOG_FILE = "activity.jsonl";

export interface ActivityEvent {
  endpoint: string;
  endpointWorkspace: string;
  provider: string;
  event: string;
  tokens?: number;
  metadata?: Record<string, unknown>;
}

export function appendRuntimeLog(home: string, message: string, metadata: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    message,
    ...metadata
  });

  appendLine(path.join(logsDir(home), RUNTIME_LOG_FILE), line);
}

export function appendActivityLog(home: string, event: ActivityEvent): void {
  appendLine(
    path.join(logsDir(home), ACTIVITY_LOG_FILE),
    JSON.stringify({
      time: new Date().toISOString(),
      ...event
    })
  );
}

export function endpointActivity(home: string, endpoint: Endpoint, event: string, metadata: Record<string, unknown> = {}): ActivityEvent {
  return {
    endpoint: endpoint.id,
    endpointWorkspace: endpointWorkspacePath(home, endpoint.id),
    provider: endpoint.provider,
    event,
    metadata
  };
}

export function readLastLines(filePath: string, count: number): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs.readFileSync(filePath, "utf8").trimEnd().split(/\r?\n/).slice(-count);
}

function appendLine(filePath: string, line: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${line}\n`);
}
