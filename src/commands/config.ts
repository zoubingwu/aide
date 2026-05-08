import { loadConfig, writeConfig, type AideConfig } from "../lib/config.js";
import { printTable } from "../lib/format.js";
import type { CodexReasoningEffort, Endpoint } from "../lib/types.js";
import type { CommandOptions } from "./options.js";
import { homeFromOptions } from "./options.js";
import { CONFIG_PATH_LIST } from "./help.js";

type EndpointAgentField = keyof Endpoint["agent"];
type EndpointTriggerField = keyof Endpoint["trigger"];
type ConfigField = "token" | EndpointAgentField | EndpointTriggerField;
type ConfigScope = "endpoint" | "agent" | "trigger";
type ConfigValue = string | boolean | string[];
type ConfigTarget = { path: string; endpoint: Endpoint; scope: ConfigScope; field: ConfigField };

const REASONING_EFFORTS: CodexReasoningEffort[] = ["low", "medium", "high", "xhigh"];

export function getConfigCommand(pathOrOptions?: string | CommandOptions, maybeOptions?: CommandOptions): void {
  const path = typeof pathOrOptions === "string" ? pathOrOptions : undefined;
  const options = maybeOptions ?? (isOptions(pathOrOptions) ? pathOrOptions : {});
  const config = loadConfig(homeFromOptions(options));

  if (path) {
    const target = resolveConfigTarget(config, path);
    console.log(`${target.path} = ${formatAssignmentValue(readConfigValue(target))}`);
    return;
  }

  console.log("Config\n");
  console.log(printTable(["Path", "Value"], configRows(config)));
}

export function setConfigCommand(path: string, value: string, options: CommandOptions): void {
  const home = homeFromOptions(options);
  const next = loadConfig(home);
  const target = resolveConfigTarget(next, path);

  setConfigValue(target, value);

  writeConfig(home, next);
  console.log(`Updated ${target.path} = ${formatAssignmentValue(readConfigValue(target))}.`);
  console.log(applyNote(target));
}

function configRows(config: AideConfig): string[][] {
  return config.endpoints.flatMap((endpoint) => [
    [`endpoints.${endpoint.id}.token`, secretStatus(endpoint.token)],
    [`endpoints.${endpoint.id}.trigger.requireMention`, formatBoolean(endpoint.trigger.requireMention)],
    [`endpoints.${endpoint.id}.trigger.freeResponseSources`, formatList(endpoint.trigger.freeResponseSources)],
    [`endpoints.${endpoint.id}.agent.provider`, endpoint.agent.provider],
    [`endpoints.${endpoint.id}.agent.command`, endpoint.agent.command],
    [`endpoints.${endpoint.id}.agent.model`, endpoint.agent.model],
    [`endpoints.${endpoint.id}.agent.reasoningEffort`, endpoint.agent.reasoningEffort]
  ]);
}

function resolveConfigTarget(config: AideConfig, path: string): ConfigTarget {
  const parts = path.split(".");
  const id = parts[1];

  if (parts[0] !== "endpoints" || !id) {
    throwUnsupportedPath(path);
  }

  if (parts.length === 3 && parts[2] === "token") {
    return {
      path: `endpoints.${id}.token`,
      endpoint: findEndpointConfig(config, id),
      scope: "endpoint",
      field: "token"
    };
  }

  const field = parts[3];

  if (parts.length === 4 && parts[2] === "agent" && isAgentField(field)) {
    return {
      path: `endpoints.${id}.agent.${field}`,
      endpoint: findEndpointConfig(config, id),
      scope: "agent",
      field
    };
  }

  if (parts.length === 4 && parts[2] === "trigger" && isTriggerField(field)) {
    return {
      path: `endpoints.${id}.trigger.${field}`,
      endpoint: findEndpointConfig(config, id),
      scope: "trigger",
      field
    };
  }

  throwUnsupportedPath(path);
}

function throwUnsupportedPath(path: string): never {
  throw new Error(`Unsupported config path: ${path}. Use ${CONFIG_PATH_LIST}.`);
}

function readConfigValue(target: ConfigTarget): ConfigValue {
  if (target.field === "token") {
    return secretStatus(target.endpoint.token);
  }

  if (target.scope === "agent") {
    return target.endpoint.agent[target.field as EndpointAgentField];
  }

  const value = target.endpoint.trigger[target.field as EndpointTriggerField];
  return value;
}

function setConfigValue(target: ConfigTarget, value: string): void {
  if (target.field === "token") {
    target.endpoint.token = nonEmptyValue(target.path, value);
    return;
  }

  if (target.scope === "trigger") {
    setTriggerConfigValue(target, value);
    return;
  }

  if (target.field === "provider") {
    throw new Error(`${target.path} is managed by endpoint creation.`);
  }

  if (target.field === "reasoningEffort") {
    target.endpoint.agent.reasoningEffort = parseReasoningEffort(value);
    return;
  }

  if (target.field === "command" || target.field === "model") {
    target.endpoint.agent[target.field] = nonEmptyValue(target.path, value);
    return;
  }

  throwUnsupportedPath(target.path);
}

function setTriggerConfigValue(target: ConfigTarget, value: string): void {
  if (target.field === "requireMention") {
    target.endpoint.trigger.requireMention = parseBoolean(target.path, value);
    return;
  }

  if (target.field === "freeResponseSources") {
    target.endpoint.trigger.freeResponseSources = parseSourceList(target.path, value);
    return;
  }

  throwUnsupportedPath(target.path);
}

function findEndpointConfig(config: AideConfig, id: string): Endpoint {
  const endpoint = config.endpoints.find((candidate) => candidate.id === id);

  if (!endpoint) {
    throw new Error(`Endpoint not found: ${id}`);
  }

  return endpoint;
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

function formatAssignmentValue(value: ConfigValue): string {
  return JSON.stringify(value);
}

function applyNote(target: ConfigTarget): string {
  if (target.field === "token") {
    return "Applies on the next start or restart.";
  }

  if (target.scope === "trigger") {
    return "Applies on the next start or restart.";
  }

  return "Applies on the next agent request.";
}

function isAgentField(value: string | undefined): value is EndpointAgentField {
  return value === "provider" || value === "command" || value === "model" || value === "reasoningEffort";
}

function isTriggerField(value: string | undefined): value is EndpointTriggerField {
  return value === "requireMention" || value === "freeResponseSources";
}

function secretStatus(value: string): string {
  return value ? "configured" : "missing";
}

function parseBoolean(path: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();

  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${path} must be true or false.`);
}

function parseSourceList(path: string, value: string): string[] {
  if (value.trim().length === 0) {
    return [];
  }

  const sources = value.split(",").map((source) => source.trim()).filter(Boolean);

  for (const source of sources) {
    if (!isTriggerSource(source)) {
      throw new Error(`${path} entries must use channel:<id>.`);
    }
  }

  return sources;
}

function isTriggerSource(value: string): boolean {
  const [kind, id, extra] = value.split(":");
  return kind === "channel" && Boolean(id) && extra === undefined;
}

function formatBoolean(value: boolean): string {
  return String(value);
}

function formatList(value: string[]): string {
  return value.join(",");
}

function isOptions(value: unknown): value is CommandOptions {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
