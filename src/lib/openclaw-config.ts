import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import JSON5 from "json5";
import { expandHome } from "./paths.js";

const OPENCLAW_INCLUDE_KEY = "$include";
const OPENCLAW_MAX_INCLUDE_DEPTH = 10;
const OPENCLAW_MAX_INCLUDE_FILE_BYTES = 2 * 1024 * 1024;

export interface OpenClawConfigOptions {
  env?: NodeJS.ProcessEnv | undefined;
  openclawHome?: string | undefined;
  openclawConfigPath?: string | undefined;
}

export interface OpenClawConfigResolution {
  home: string;
  path?: string | undefined;
  exists: boolean;
  explicit: boolean;
  config: unknown;
}

export interface OpenClawShellEnvPlan {
  keys: string[];
  command: string;
}

export function resolveOpenClawConfig(options: OpenClawConfigOptions = {}): OpenClawConfigResolution {
  const home = resolveOpenClawHome(options);
  const configPath = openClawConfigPath(options, home);

  if (configPath.explicit && !configPath.exists) {
    throw new Error(`OpenClaw config not found: ${configPath.path}`);
  }

  return {
    home,
    path: configPath.path,
    exists: configPath.exists,
    explicit: configPath.explicit,
    config: readOpenClawConfigObject(configPath.exists ? configPath.path : undefined)
  };
}

export function resolveOpenClawHome(options: OpenClawConfigOptions): string {
  const env = options.env ?? process.env;
  return expandHome(options.openclawHome ?? env.OPENCLAW_HOME ?? env.OPENCLAW_STATE_DIR ?? "~/.openclaw");
}

export function readOpenClawConfigObject(filePath: string | undefined): unknown {
  const config = readJson5Object(filePath);

  if (!filePath || config === undefined) {
    return config;
  }

  const resolvedPath = path.resolve(filePath);
  return resolveOpenClawConfigIncludes(config, resolvedPath, new Set([resolvedPath]), 0);
}

export function openClawConfigEnvValues(value: Record<string, unknown>): Record<string, string> {
  return {
    ...recordToStringMap(value),
    ...recordToStringMap(objectConfig(value.vars))
  };
}

export function openClawShellEnvValues(params: {
  configEnv?: Record<string, unknown> | undefined;
  values: Record<string, string>;
  keys: Iterable<string>;
}): Record<string, string> {
  const plan = planOpenClawShellEnv(params);

  if (!plan) {
    return {};
  }

  const shellEnv = readLoginShellEnv(params.values, openClawShellEnvTimeoutMs(params.configEnv, params.values));
  const values: Record<string, string> = {};

  for (const key of plan.keys) {
    const value = shellEnv[key];

    if (value !== undefined) {
      values[key] = value;
    }
  }

  return values;
}

export function planOpenClawShellEnv(params: {
  configEnv?: Record<string, unknown> | undefined;
  values: Record<string, string>;
  keys: Iterable<string>;
}): OpenClawShellEnvPlan | undefined {
  if (!openClawShellEnvEnabled(params.configEnv, params.values)) {
    return undefined;
  }

  const keys = [...new Set(params.keys)].filter((key) => params.values[key] === undefined);

  if (keys.length === 0) {
    return undefined;
  }

  return {
    keys,
    command: openClawShellEnvCommand(params.values)
  };
}

function openClawConfigPath(options: OpenClawConfigOptions, home: string): { path?: string | undefined; exists: boolean; explicit: boolean } {
  const env = options.env ?? process.env;
  const explicitPath = options.openclawConfigPath ?? env.OPENCLAW_CONFIG_PATH;

  if (explicitPath) {
    const filePath = expandHome(explicitPath);
    return {
      path: filePath,
      exists: fs.existsSync(filePath),
      explicit: true
    };
  }

  const fallbackPath = path.join(home, "openclaw.json");
  return {
    path: fs.existsSync(fallbackPath) ? fallbackPath : undefined,
    exists: fs.existsSync(fallbackPath),
    explicit: false
  };
}

function readJson5Object(filePath: string | undefined): unknown {
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined;
  }

  const content = fs.readFileSync(filePath, "utf8").trim();
  return content.length > 0 ? JSON5.parse(content) : undefined;
}

function openClawShellEnvEnabled(
  configEnv: Record<string, unknown> | undefined,
  values: Record<string, string>
): boolean {
  const shellEnv = objectConfig(configEnv?.shellEnv);
  return getBoolean(shellEnv.enabled) ?? parseBoolean(values.OPENCLAW_LOAD_SHELL_ENV) ?? false;
}

function openClawShellEnvTimeoutMs(
  configEnv: Record<string, unknown> | undefined,
  values: Record<string, string>
): number {
  const shellEnv = objectConfig(configEnv?.shellEnv);
  return numberConfig(shellEnv.timeoutMs) ?? numberFromString(values.OPENCLAW_SHELL_ENV_TIMEOUT_MS) ?? 15_000;
}

function readLoginShellEnv(values: Record<string, string>, timeoutMs: number): Record<string, string> {
  const output = readShellEnvOutput(values, timeoutMs);
  return parseEnvOutput(output);
}

function readShellEnvOutput(values: Record<string, string>, timeoutMs: number): string {
  if (process.platform === "win32") {
    return execFileSync(openClawShellEnvCommand(values), ["/d", "/s", "/c", "set"], {
      encoding: "utf8",
      env: values,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs
    });
  }

  const envCommand = fs.existsSync("/usr/bin/env") ? "/usr/bin/env" : "env";

  try {
    return execFileSync(openClawShellEnvCommand(values), ["-lc", envCommand], {
      encoding: "utf8",
      env: values,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs
    });
  } catch (error) {
    throw new Error(`OpenClaw shellEnv import failed: ${errorMessage(error)}`);
  }
}

function openClawShellEnvCommand(values: Record<string, string>): string {
  if (process.platform === "win32") {
    return values.ComSpec ?? process.env.ComSpec ?? "cmd.exe";
  }

  return values.SHELL ?? process.env.SHELL ?? "/bin/sh";
}

function parseEnvOutput(output: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of output.split(/\r?\n/)) {
    const equalsIndex = line.indexOf("=");

    if (equalsIndex > 0) {
      values[line.slice(0, equalsIndex)] = line.slice(equalsIndex + 1);
    }
  }

  return values;
}

function resolveOpenClawConfigIncludes(
  value: unknown,
  baseFilePath: string,
  seenPaths: Set<string>,
  depth: number
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveOpenClawConfigIncludes(entry, baseFilePath, seenPaths, depth));
  }

  if (!isRecord(value)) {
    return value;
  }

  if (objectHasOwn(value, OPENCLAW_INCLUDE_KEY)) {
    const included = resolveOpenClawConfigInclude(value[OPENCLAW_INCLUDE_KEY], baseFilePath, seenPaths, depth);
    const local: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
      if (key === OPENCLAW_INCLUDE_KEY || isUnsafeObjectKey(key)) {
        continue;
      }

      local[key] = resolveOpenClawConfigIncludes(entry, baseFilePath, seenPaths, depth);
    }

    return Object.keys(local).length > 0 ? deepMergeOpenClawConfig(included, local) : included;
  }

  const result: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (!isUnsafeObjectKey(key)) {
      result[key] = resolveOpenClawConfigIncludes(entry, baseFilePath, seenPaths, depth);
    }
  }

  return result;
}

function resolveOpenClawConfigInclude(
  includeValue: unknown,
  baseFilePath: string,
  seenPaths: Set<string>,
  depth: number
): unknown {
  if (typeof includeValue === "string") {
    return loadOpenClawConfigInclude(includeValue, baseFilePath, seenPaths, depth);
  }

  if (Array.isArray(includeValue)) {
    return includeValue.reduce<unknown>(
      (merged, entry) => deepMergeOpenClawConfig(
        merged,
        resolveOpenClawConfigInclude(entry, baseFilePath, seenPaths, depth)
      ),
      {}
    );
  }

  return undefined;
}

function loadOpenClawConfigInclude(
  includePath: string,
  baseFilePath: string,
  seenPaths: Set<string>,
  depth: number
): unknown {
  if (depth >= OPENCLAW_MAX_INCLUDE_DEPTH) {
    throw new Error(`OpenClaw config include depth exceeded at ${includePath}.`);
  }

  const resolvedPath = resolveOpenClawIncludePath(includePath, baseFilePath);

  if (seenPaths.has(resolvedPath)) {
    throw new Error(`OpenClaw config include cycle detected at ${resolvedPath}.`);
  }

  const stats = fs.statSync(resolvedPath);

  if (!stats.isFile()) {
    throw new Error(`OpenClaw config include is not a file: ${resolvedPath}`);
  }

  if (stats.size > OPENCLAW_MAX_INCLUDE_FILE_BYTES) {
    throw new Error(`OpenClaw config include exceeds max size: ${resolvedPath}`);
  }

  seenPaths.add(resolvedPath);

  try {
    return resolveOpenClawConfigIncludes(readJson5Object(resolvedPath), resolvedPath, seenPaths, depth + 1);
  } finally {
    seenPaths.delete(resolvedPath);
  }
}

function resolveOpenClawIncludePath(includePath: string, baseFilePath: string): string {
  const expandedPath = includePath === "~" || includePath.startsWith("~/") ? expandHome(includePath) : includePath;
  return path.isAbsolute(expandedPath) ? expandedPath : path.resolve(path.dirname(baseFilePath), expandedPath);
}

function deepMergeOpenClawConfig(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source];
  }

  if (isRecord(target) && isRecord(source)) {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(target)) {
      if (!isUnsafeObjectKey(key)) {
        result[key] = value;
      }
    }

    for (const [key, value] of Object.entries(source)) {
      if (!isUnsafeObjectKey(key)) {
        result[key] = objectHasOwn(result, key) ? deepMergeOpenClawConfig(result[key], value) : value;
      }
    }

    return result;
  }

  return source;
}

function recordToStringMap(value: Record<string, unknown>): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      entries[key] = entry;
    }
  }

  return entries;
}

function objectConfig(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectHasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isUnsafeObjectKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function getBoolean(value: unknown): boolean | undefined {
  return parseBoolean(value);
}

function numberConfig(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberFromString(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
