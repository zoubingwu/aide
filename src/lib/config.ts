import fs from "node:fs";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import {
  configPath,
  displayPath,
  logsDir,
  pendingDeliveriesPath,
  runtimePath,
  schedulesPath,
  usagePath,
  workspaceDir
} from "./paths.js";
import type { CodexAgentConfig, Endpoint, EndpointTriggerConfig, RuntimeState } from "./types.js";

const DEFAULT_RUNTIME_MODEL = "gpt-5.5";
const DEFAULT_REASONING_EFFORT = "medium";
const DEFAULT_OUTPUT_MODE = "concise";

const codexReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
const agentOutputModeSchema = z.enum(["concise", "verbose"]);

const codexAgentConfigSchema = z.object({
  provider: z.literal("codex").default("codex"),
  command: z.string().min(1).default("codex"),
  model: z.string().min(1).default(DEFAULT_RUNTIME_MODEL),
  reasoningEffort: codexReasoningEffortSchema.default(DEFAULT_REASONING_EFFORT),
  outputMode: agentOutputModeSchema.default(DEFAULT_OUTPUT_MODE)
});

const discordTriggerSourceSchema = z.string().refine(isDiscordTriggerSource, {
  message: "Unsupported trigger source. Use channel:<id>."
});

const endpointTriggerConfigSchema = z.object({
  requireMention: z.boolean().default(true),
  freeResponseSources: z.array(discordTriggerSourceSchema).default([])
}).default(defaultEndpointTriggerConfig);

const endpointSchema = z.object({
  id: z.string().min(1),
  provider: z.literal("discord"),
  enabled: z.boolean(),
  token: z.string().min(1),
  trigger: endpointTriggerConfigSchema,
  agent: codexAgentConfigSchema.default(defaultCodexAgentConfig)
});

const runtimeStateSchema = z.object({
  status: z.enum(["running", "stopped"]).default("stopped"),
  home: z.string().min(1),
  pid: z.number().int().positive().optional(),
  startedAt: z.string().optional()
});

const configSchema = z.object({
  endpoints: z.array(endpointSchema).default([])
});

export type AideConfig = z.infer<typeof configSchema>;

export function defaultConfig(): AideConfig {
  return {
    endpoints: []
  };
}

export function defaultCodexAgentConfig(): CodexAgentConfig {
  return {
    provider: "codex",
    command: "codex",
    model: DEFAULT_RUNTIME_MODEL,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    outputMode: DEFAULT_OUTPUT_MODE
  };
}

export function defaultEndpointTriggerConfig(): EndpointTriggerConfig {
  return {
    requireMention: true,
    freeResponseSources: []
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

  writeFileIfMissing(configPath(home), `${stringifyConfig(defaultConfig())}\n`, 0o600);
  secureConfigFile(home);
  writeFileIfMissing(schedulesPath(home), `${JSON.stringify({ schedules: [] }, null, 2)}\n`);
  writeFileIfMissing(pendingDeliveriesPath(home), `${JSON.stringify({ deliveries: [] }, null, 2)}\n`, 0o600);
  securePendingDeliveriesFile(home);
  writeFileIfMissing(runtimePath(home), `${JSON.stringify(defaultRuntimeState(home), null, 2)}\n`);
  writeFileIfMissing(usagePath(home), "");
}

export function assertInitialized(home: string): void {
  if (!fs.existsSync(configPath(home))) {
    throw new Error("Aide is not initialized. Run `aide init` first.");
  }

  secureConfigFile(home);
}

export function loadConfig(home: string): AideConfig {
  assertInitialized(home);
  return configSchema.parse(readToml(configPath(home)));
}

export function writeConfig(home: string, config: AideConfig): void {
  const filePath = configPath(home);
  fs.writeFileSync(filePath, `${stringifyConfig(config)}\n`, { mode: 0o600 });
  secureConfigFile(home);
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
  fs.writeFileSync(runtimePath(home), `${JSON.stringify(runtimeStateSchema.parse(state), null, 2)}\n`);
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

  return parseToml(content);
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

function writeFileIfMissing(filePath: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, mode === undefined ? undefined : { mode });
  }
}

function secureConfigFile(home: string): void {
  fs.chmodSync(configPath(home), 0o600);
}

function securePendingDeliveriesFile(home: string): void {
  fs.chmodSync(pendingDeliveriesPath(home), 0o600);
}

function stringifyConfig(config: AideConfig): string {
  const parsed = configSchema.parse(config);

  if (parsed.endpoints.length === 0) {
    return stringifyToml(parsed);
  }

  return parsed.endpoints.map(stringifyEndpointConfig).join("\n\n");
}

function stringifyEndpointConfig(endpoint: Endpoint): string {
  return [
    "[[endpoints]]",
    `id = ${tomlValue(endpoint.id)}`,
    `provider = ${tomlValue(endpoint.provider)}`,
    `enabled = ${tomlValue(endpoint.enabled)}`,
    `token = ${tomlValue(endpoint.token)}`,
    `trigger = ${tomlInlineTable([
      ["requireMention", endpoint.trigger.requireMention],
      ["freeResponseSources", endpoint.trigger.freeResponseSources]
    ])}`,
    `agent = ${tomlInlineTable([
      ["provider", endpoint.agent.provider],
      ["command", endpoint.agent.command],
      ["model", endpoint.agent.model],
      ["reasoningEffort", endpoint.agent.reasoningEffort],
      ["outputMode", endpoint.agent.outputMode]
    ])}`
  ].join("\n");
}

function tomlInlineTable(entries: Array<[string, string | boolean | string[]]>): string {
  return `{ ${entries.map(([key, value]) => `${key} = ${tomlValue(value)}`).join(", ")} }`;
}

function tomlValue(value: string | boolean | string[]): string {
  const key = "__value__";
  const line = stringifyToml({ [key]: value }).trim();
  return line.slice(`${key} = `.length);
}

function isDiscordTriggerSource(value: string): boolean {
  const [kind, id, extra] = value.split(":");
  return kind === "channel" && Boolean(id) && extra === undefined;
}
