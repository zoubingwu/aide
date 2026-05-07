import fs from "node:fs";
import path from "node:path";
import * as TOML from "@iarna/toml";
import { z } from "zod";
import {
  configPath,
  displayPath,
  logsDir,
  runtimePath,
  schedulesPath,
  usagePath,
  workspaceDir
} from "./paths.js";
import type { AideConfig, CodexAgentConfig, Endpoint, RuntimeConfig, RuntimeState } from "./types.js";

const DEFAULT_RUNTIME_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT = "medium";

const codexReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);

const runtimeConfigSchema = z.object({
  startupTimeoutMs: z.number().int().positive().default(30_000)
});

const codexAgentConfigSchema = z.object({
  provider: z.literal("codex").default("codex"),
  command: z.string().min(1).default("codex"),
  model: z.string().min(1).default(DEFAULT_RUNTIME_MODEL),
  reasoningEffort: codexReasoningEffortSchema.default(DEFAULT_REASONING_EFFORT)
});

const endpointSchema = z.object({
  id: z.string().min(1),
  provider: z.literal("discord"),
  enabled: z.boolean(),
  token: z.string().min(1),
  agent: codexAgentConfigSchema.default(defaultCodexAgentConfig)
});

const runtimeStateSchema = z.object({
  status: z.enum(["running", "stopped"]).default("stopped"),
  home: z.string().min(1),
  pid: z.number().int().positive().optional(),
  startedAt: z.string().optional()
});

const configSchema = z.object({
  home: z.string().min(1),
  runtime: runtimeConfigSchema.default(defaultRuntimeConfig),
  endpoints: z.array(endpointSchema).default([])
});

export function defaultConfig(home: string): AideConfig {
  return {
    home: displayPath(home),
    runtime: defaultRuntimeConfig(),
    endpoints: []
  };
}

function defaultRuntimeConfig(): RuntimeConfig {
  return {
    startupTimeoutMs: 30_000
  };
}

export function defaultCodexAgentConfig(): CodexAgentConfig {
  return {
    provider: "codex",
    command: "codex",
    model: DEFAULT_RUNTIME_MODEL,
    reasoningEffort: DEFAULT_REASONING_EFFORT
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

  writeFileIfMissing(configPath(home), stringifyToml(defaultConfig(home)), 0o600);
  writeFileIfMissing(schedulesPath(home), stringifyJson({ schedules: [] }));
  writeFileIfMissing(runtimePath(home), stringifyJson(defaultRuntimeState(home)));
  writeFileIfMissing(usagePath(home), "");
}

export function assertInitialized(home: string): void {
  if (!fs.existsSync(configPath(home))) {
    throw new Error("Aide is not initialized. Run `aide init` first.");
  }
}

export function loadConfig(home: string): AideConfig {
  assertInitialized(home);
  return configSchema.parse(readToml(configPath(home)));
}

export function writeConfig(home: string, config: AideConfig): void {
  const filePath = configPath(home);
  fs.writeFileSync(filePath, stringifyToml(configSchema.parse(config)), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

export function loadEndpoints(home: string): Endpoint[] {
  return loadConfig(home).endpoints;
}

export function writeEndpoints(home: string, endpoints: Endpoint[]): void {
  const config = loadConfig(home);
  writeConfig(home, { ...config, endpoints });
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

export function readJson(filePath: string, fallback: unknown): unknown {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  const content = fs.readFileSync(filePath, "utf8").trim();

  if (content.length === 0) {
    return fallback;
  }

  return JSON.parse(content);
}

export function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFileIfMissing(filePath: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, mode === undefined ? undefined : { mode });
  }
}
