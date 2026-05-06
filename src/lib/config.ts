import fs from "node:fs";
import path from "node:path";
import * as TOML from "@iarna/toml";
import { z } from "zod";
import {
  configPath,
  displayPath,
  endpointsPath,
  logsDir,
  runtimePath,
  usagePath,
  workspaceDir
} from "./paths.js";
import type { AideConfig, Endpoint, EndpointsFile, RuntimeConfig, RuntimeState } from "./types.js";

const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  provider: "codex",
  command: "codex",
  args: ["exec", "resume", "--last", "--json", "--skip-git-repo-check"],
  startupTimeoutMs: 30_000
};

const runtimeConfigSchema = z.object({
  provider: z.literal("codex").default("codex"),
  command: z.string().min(1).default("codex"),
  args: z.array(z.string()).default(["exec", "resume", "--last", "--json", "--skip-git-repo-check"]),
  startupTimeoutMs: z.number().int().positive().default(30_000)
});

const configSchema = z.object({
  home: z.string().min(1),
  runtime: runtimeConfigSchema.default(DEFAULT_RUNTIME_CONFIG)
});

const endpointSchema = z.object({
  id: z.string().min(1),
  provider: z.literal("discord"),
  enabled: z.boolean()
});

const endpointsFileSchema = z.object({
  endpoints: z.array(endpointSchema).default([])
});

const runtimeStateSchema = z.object({
  status: z.enum(["running", "stopped"]).default("stopped"),
  home: z.string().min(1),
  pid: z.number().int().positive().optional(),
  startedAt: z.string().optional()
});

export function defaultConfig(home: string): AideConfig {
  return {
    home: displayPath(home),
    runtime: DEFAULT_RUNTIME_CONFIG
  };
}

export function defaultRuntimeState(home: string): RuntimeState {
  return {
    status: "stopped",
    home: displayPath(home)
  };
}

export function ensureAideHome(home: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(logsDir(home), { recursive: true });
  fs.mkdirSync(workspaceDir(home), { recursive: true });

  writeFileIfMissing(configPath(home), stringifyToml(defaultConfig(home)));
  writeFileIfMissing(endpointsPath(home), stringifyToml({ endpoints: [] }));
  writeFileIfMissing(runtimePath(home), stringifyJson(defaultRuntimeState(home)));
  writeFileIfMissing(usagePath(home), "");
}

export function assertInitialized(home: string): void {
  if (!fs.existsSync(configPath(home)) || !fs.existsSync(endpointsPath(home))) {
    throw new Error("Aide is not initialized. Run `aide init` first.");
  }
}

export function loadConfig(home: string): AideConfig {
  assertInitialized(home);
  return configSchema.parse(readToml(configPath(home)));
}

export function writeConfig(home: string, config: AideConfig): void {
  fs.writeFileSync(configPath(home), stringifyToml(configSchema.parse(config)));
}

export function loadEndpoints(home: string): Endpoint[] {
  assertInitialized(home);
  return endpointsFileSchema.parse(readToml(endpointsPath(home))).endpoints;
}

export function writeEndpoints(home: string, endpoints: Endpoint[]): void {
  const body: EndpointsFile = { endpoints };
  fs.writeFileSync(endpointsPath(home), stringifyToml(endpointsFileSchema.parse(body)));
}

export function loadRuntimeState(home: string): RuntimeState {
  assertInitialized(home);
  return runtimeStateSchema.parse(readJson(runtimePath(home), defaultRuntimeState(home)));
}

export function writeRuntimeState(home: string, state: RuntimeState): void {
  fs.writeFileSync(runtimePath(home), stringifyJson(runtimeStateSchema.parse(state)));
}

export function findEndpoint(home: string, id: string): Endpoint {
  const endpoint = loadEndpoints(home).find((candidate) => candidate.id === id);

  if (!endpoint) {
    throw new Error(`Endpoint not found: ${id}`);
  }

  return endpoint;
}

export function requireEndpointIndex(endpoints: Endpoint[], id: string): number {
  const index = endpoints.findIndex((endpoint) => endpoint.id === id);

  if (index === -1) {
    throw new Error(`Endpoint not found: ${id}`);
  }

  return index;
}

export function readToml(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, "utf8").trim();

  if (content.length === 0) {
    return {};
  }

  return TOML.parse(content);
}

export function stringifyToml(value: unknown): string {
  return `${TOML.stringify(value as Parameters<typeof TOML.stringify>[0])}\n`;
}

function readJson(filePath: string, fallback: unknown): unknown {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  const content = fs.readFileSync(filePath, "utf8").trim();

  if (content.length === 0) {
    return fallback;
  }

  return JSON.parse(content);
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFileIfMissing(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
  }
}
