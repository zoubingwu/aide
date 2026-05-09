import fs from "node:fs";
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
  config: unknown;
}

export function resolveOpenClawConfig(options: OpenClawConfigOptions = {}): OpenClawConfigResolution {
  const home = resolveOpenClawHome(options);
  const configPath = resolveOpenClawConfigPath(options, home);

  return {
    home,
    path: configPath,
    config: readOpenClawConfigObject(configPath)
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

function resolveOpenClawConfigPath(options: OpenClawConfigOptions, home: string): string | undefined {
  const env = options.env ?? process.env;
  const explicitPath = options.openclawConfigPath ?? env.OPENCLAW_CONFIG_PATH;
  const fallbackPath = path.join(home, "openclaw.json");
  const candidates = [explicitPath ? expandHome(explicitPath) : undefined, fallbackPath].filter(Boolean) as string[];
  return candidates.find((filePath) => fs.existsSync(filePath));
}

function readJson5Object(filePath: string | undefined): unknown {
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined;
  }

  const content = fs.readFileSync(filePath, "utf8").trim();
  return content.length > 0 ? JSON5.parse(content) : undefined;
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
