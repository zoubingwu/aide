import os from "node:os";
import path from "node:path";

export const DEFAULT_HOME = "~/.aide";

export function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return path.resolve(value);
}

export function resolveAideHome(explicitHome?: string): string {
  return expandHome(explicitHome ?? process.env.AIDE_HOME ?? DEFAULT_HOME);
}

export function displayPath(value: string): string {
  const home = os.homedir();

  if (value === home) {
    return "~";
  }

  if (value.startsWith(`${home}${path.sep}`)) {
    return `~/${path.relative(home, value)}`;
  }

  return value;
}

export function endpointWorkspacePath(home: string, endpointId: string): string {
  return path.join(home, "workspace", endpointId);
}

export function configPath(home: string): string {
  return path.join(home, "config.toml");
}

export function schedulesPath(home: string): string {
  return path.join(home, "schedules.json");
}

export function pendingDeliveriesPath(home: string): string {
  return path.join(home, "pending-deliveries.json");
}

export function runtimePath(home: string): string {
  return path.join(home, "runtime.json");
}

export function usagePath(home: string): string {
  return path.join(home, "usage.jsonl");
}

export function logsDir(home: string): string {
  return path.join(home, "logs");
}

export function workspaceDir(home: string): string {
  return path.join(home, "workspace");
}

export function slugifyId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function envKeySegment(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
