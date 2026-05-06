import { loadConfig, writeConfig } from "../lib/config.js";
import { printTable } from "../lib/format.js";
import type { AideConfig, CodexReasoningEffort } from "../lib/types.js";
import type { CommandOptions } from "./options.js";
import { homeFromOptions } from "./options.js";
import { CONFIG_PATHS } from "./help.js";

type ConfigPath = (typeof CONFIG_PATHS)[number];

const REASONING_EFFORTS: CodexReasoningEffort[] = ["low", "medium", "high", "xhigh"];

export function getConfigCommand(pathOrOptions?: string | CommandOptions, maybeOptions?: CommandOptions): void {
  const path = typeof pathOrOptions === "string" ? pathOrOptions : undefined;
  const options = maybeOptions ?? (isOptions(pathOrOptions) ? pathOrOptions : {});
  const config = loadConfig(homeFromOptions(options));

  if (path) {
    console.log(`${path} = ${formatAssignmentValue(readConfigValue(config, parseConfigPath(path)))}`);
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
    runtime: { ...config.runtime }
  };

  switch (key) {
    case "runtime.command":
      next.runtime.command = nonEmptyValue(key, value);
      break;
    case "runtime.args":
      next.runtime.args = parseArgs(value);
      break;
    case "runtime.model":
      next.runtime.model = nonEmptyValue(key, value);
      break;
    case "runtime.reasoningEffort":
      next.runtime.reasoningEffort = parseReasoningEffort(value);
      break;
    case "runtime.startupTimeoutMs":
      next.runtime.startupTimeoutMs = parsePositiveInteger(key, value);
      break;
  }

  writeConfig(home, next);
  console.log(`Updated ${key} = ${formatAssignmentValue(readConfigValue(next, key))}.`);
  console.log(applyNote(key));
}

function configRows(config: AideConfig): string[][] {
  return [
    ["home", config.home],
    ["runtime.provider", config.runtime.provider],
    ["runtime.command", config.runtime.command],
    ["runtime.args", JSON.stringify(config.runtime.args)],
    ["runtime.model", config.runtime.model],
    ["runtime.reasoningEffort", config.runtime.reasoningEffort],
    ["runtime.startupTimeoutMs", String(config.runtime.startupTimeoutMs)]
  ];
}

function parseConfigPath(path: string): ConfigPath {
  if ((CONFIG_PATHS as readonly string[]).includes(path)) {
    return path as ConfigPath;
  }

  throw new Error(`Unsupported config path: ${path}. Use ${CONFIG_PATHS.join(", ")}.`);
}

function readConfigValue(config: AideConfig, path: ConfigPath): string | string[] | number {
  switch (path) {
    case "runtime.command":
      return config.runtime.command;
    case "runtime.args":
      return config.runtime.args;
    case "runtime.model":
      return config.runtime.model;
    case "runtime.reasoningEffort":
      return config.runtime.reasoningEffort;
    case "runtime.startupTimeoutMs":
      return config.runtime.startupTimeoutMs;
  }
}

function nonEmptyValue(path: ConfigPath, value: string): string {
  if (value.length > 0) {
    return value;
  }

  throw new Error(`${path} must be non-empty.`);
}

function parseArgs(value: string): string[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("runtime.args must be a JSON array of strings.");
  }

  if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
    return parsed;
  }

  throw new Error("runtime.args must be a JSON array of strings.");
}

function parseReasoningEffort(value: string): CodexReasoningEffort {
  if (REASONING_EFFORTS.includes(value as CodexReasoningEffort)) {
    return value as CodexReasoningEffort;
  }

  throw new Error(`runtime.reasoningEffort must be one of: ${REASONING_EFFORTS.join(", ")}.`);
}

function parsePositiveInteger(path: ConfigPath, value: string): number {
  const parsed = Number(value);

  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  throw new Error(`${path} must be a positive integer.`);
}

function formatAssignmentValue(value: string | string[] | number): string {
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

function applyNote(path: ConfigPath): string {
  if (path === "runtime.startupTimeoutMs") {
    return "Applies on the next start or restart.";
  }

  return "Applies on the next agent request.";
}

function isOptions(value: unknown): value is CommandOptions {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
