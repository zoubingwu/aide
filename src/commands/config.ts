import { loadConfig, writeConfig } from "../lib/config.js";
import { printTable } from "../lib/format.js";
import type { AideConfig, CodexReasoningEffort, Endpoint } from "../lib/types.js";
import type { CommandOptions } from "./options.js";
import { homeFromOptions } from "./options.js";
import { CONFIG_PATH_LIST } from "./help.js";

type ConfigPath =
  | { kind: "runtimeStartupTimeout" }
  | { kind: "endpointAgent"; id: string; field: EndpointAgentField };

type EndpointAgentField = "provider" | "command" | "model" | "reasoningEffort";

const REASONING_EFFORTS: CodexReasoningEffort[] = ["low", "medium", "high", "xhigh"];

export function getConfigCommand(pathOrOptions?: string | CommandOptions, maybeOptions?: CommandOptions): void {
  const path = typeof pathOrOptions === "string" ? pathOrOptions : undefined;
  const options = maybeOptions ?? (isOptions(pathOrOptions) ? pathOrOptions : {});
  const config = loadConfig(homeFromOptions(options));

  if (path) {
    const parsed = parseConfigPath(path);
    console.log(`${formatConfigPath(parsed)} = ${formatAssignmentValue(readConfigValue(config, parsed))}`);
    return;
  }

  console.log("Config\n");
  console.log(printTable(["Path", "Value"], configRows(config)));
}

export function setConfigCommand(path: string, value: string, options: CommandOptions): void {
  const home = homeFromOptions(options);
  const key = parseConfigPath(path);
  const config = loadConfig(home);
  const next: AideConfig = {
    ...config,
    runtime: { ...config.runtime },
    endpoints: config.endpoints.map((endpoint) => ({
      ...endpoint,
      agent: { ...endpoint.agent }
    }))
  };

  switch (key.kind) {
    case "runtimeStartupTimeout":
      next.runtime.startupTimeoutMs = parsePositiveInteger(formatConfigPath(key), value);
      break;
    case "endpointAgent": {
      const endpoint = findEndpointConfig(next, key.id);

      switch (key.field) {
        case "command":
          endpoint.agent.command = nonEmptyValue(formatConfigPath(key), value);
          break;
        case "model":
          endpoint.agent.model = nonEmptyValue(formatConfigPath(key), value);
          break;
        case "reasoningEffort":
          endpoint.agent.reasoningEffort = parseReasoningEffort(value);
          break;
        case "provider":
          throw new Error(`${formatConfigPath(key)} is managed by endpoint creation.`);
      }
      break;
    }
  }

  writeConfig(home, next);
  console.log(`Updated ${formatConfigPath(key)} = ${formatAssignmentValue(readConfigValue(next, key))}.`);
  console.log(applyNote(key));
}

function configRows(config: AideConfig): string[][] {
  const rows = [
    ["home", config.home],
    ["runtime.startupTimeoutMs", String(config.runtime.startupTimeoutMs)]
  ];

  for (const endpoint of config.endpoints) {
    rows.push(
      [`endpoints.${endpoint.id}.agent.provider`, endpoint.agent.provider],
      [`endpoints.${endpoint.id}.agent.command`, endpoint.agent.command],
      [`endpoints.${endpoint.id}.agent.model`, endpoint.agent.model],
      [`endpoints.${endpoint.id}.agent.reasoningEffort`, endpoint.agent.reasoningEffort]
    );
  }

  return rows;
}

function parseConfigPath(path: string): ConfigPath {
  if (path === "runtime.startupTimeoutMs") {
    return { kind: "runtimeStartupTimeout" };
  }

  const match = /^endpoints\.([a-z0-9][a-z0-9-]*)\.agent\.(provider|command|model|reasoningEffort)$/.exec(path);

  if (match?.[1] && match[2]) {
    return {
      kind: "endpointAgent",
      id: match[1],
      field: match[2] as EndpointAgentField
    };
  }

  throw new Error(`Unsupported config path: ${path}. Use ${CONFIG_PATH_LIST}.`);
}

function readConfigValue(config: AideConfig, path: ConfigPath): string | number {
  switch (path.kind) {
    case "runtimeStartupTimeout":
      return config.runtime.startupTimeoutMs;
    case "endpointAgent": {
      const endpoint = findEndpointConfig(config, path.id);
      return endpoint.agent[path.field];
    }
  }
}

function findEndpointConfig(config: AideConfig, id: string): Endpoint {
  const endpoint = config.endpoints.find((candidate) => candidate.id === id);

  if (!endpoint) {
    throw new Error(`Endpoint not found: ${id}`);
  }

  return endpoint;
}

function formatConfigPath(path: ConfigPath): string {
  switch (path.kind) {
    case "runtimeStartupTimeout":
      return "runtime.startupTimeoutMs";
    case "endpointAgent":
      return `endpoints.${path.id}.agent.${path.field}`;
  }
}

function nonEmptyValue(path: string, value: string): string {
  if (value.length > 0) {
    return value;
  }

  throw new Error(`${path} must be non-empty.`);
}

function parseReasoningEffort(value: string): CodexReasoningEffort {
  if (REASONING_EFFORTS.includes(value as CodexReasoningEffort)) {
    return value as CodexReasoningEffort;
  }

  throw new Error(`reasoningEffort must be one of: ${REASONING_EFFORTS.join(", ")}.`);
}

function parsePositiveInteger(path: string, value: string): number {
  const parsed = Number(value);

  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  throw new Error(`${path} must be a positive integer.`);
}

function formatAssignmentValue(value: string | number): string {
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

function applyNote(path: ConfigPath): string {
  if (path.kind === "runtimeStartupTimeout") {
    return "Applies on the next start or restart.";
  }

  return "Applies on the next agent request.";
}

function isOptions(value: unknown): value is CommandOptions {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
