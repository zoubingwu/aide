import crypto from "node:crypto";
import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { slugifyId } from "../paths.js";
import type { Provider } from "../types.js";
import type { ImportSource } from "./types.js";

export function readJsonPointer(target: unknown, pointer: string): unknown {
  if (pointer === "") {
    return target;
  }

  if (!pointer.startsWith("/")) {
    throw new Error(`File SecretRef JSON pointer must start with /: ${pointer}`);
  }

  let current = target;

  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");

    if (Array.isArray(current)) {
      current = current[Number(segment)];
      continue;
    }

    if (!isRecord(current)) {
      throw new Error(`File SecretRef JSON pointer is missing: ${pointer}`);
    }

    current = current[segment];
  }

  return current;
}

export function normalizeSecretString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`SecretRef ${label} resolved to an empty or non-string value.`);
  }

  return value.trim();
}

export function endpointIdFor(source: Exclude<ImportSource, "all">, sourceName: string): string {
  const base = sourceName === "default" ? source : `${source}-${sourceName}`;
  return slugifyId(base);
}

export function providerEndpointIdFor(provider: Provider, sourceName: string): string {
  const base = sourceName === "default" ? provider : `${provider}-${sourceName}`;
  return slugifyId(base);
}

export function nextEndpointId(baseId: string, usedIds: Set<string>): string {
  if (!usedIds.has(baseId)) {
    return baseId;
  }

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseId}-${suffix}`;

    if (!usedIds.has(candidate)) {
      return candidate;
    }
  }
}

export function tokenFingerprint(token: string): string {
  return `sha256:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

export function readYamlObject(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  const content = fs.readFileSync(filePath, "utf8").trim();
  return content.length > 0 ? parseYaml(content) : undefined;
}

export function readEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const values: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const parsed = parseEnvLine(line);

    if (parsed) {
      values[parsed.key] = parsed.value;
    }
  }

  return values;
}

function parseEnvLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();

  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return undefined;
  }

  const equalsIndex = trimmed.indexOf("=");

  if (equalsIndex === -1) {
    return undefined;
  }

  const key = trimmed.slice(0, equalsIndex).trim();
  const value = trimEnvValue(trimmed.slice(equalsIndex + 1).trim());
  return key ? { key, value } : undefined;
}

function trimEnvValue(value: string): string {
  const quote = value[0];

  if ((quote === "\"" || quote === "'") && value.endsWith(quote)) {
    return value.slice(1, -1);
  }

  const commentIndex = value.indexOf(" #");
  return commentIndex === -1 ? value : value.slice(0, commentIndex).trimEnd();
}

export function firstStringPath(
  target: unknown,
  paths: readonly (readonly string[])[],
  env: Record<string, string>
): string | undefined {
  for (const candidatePath of paths) {
    const value = getPath(target, candidatePath);

    if (typeof value === "string") {
      return substituteEnv(value, env);
    }
  }

  return undefined;
}

export function firstBooleanPath(target: unknown, paths: readonly (readonly string[])[]): boolean | undefined {
  for (const candidatePath of paths) {
    const parsed = parseBoolean(getPath(target, candidatePath));

    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

export function firstStringArrayPath(target: unknown, paths: readonly (readonly string[])[]): string[] | string | undefined {
  for (const candidatePath of paths) {
    const value = getPath(target, candidatePath);

    if (typeof value === "string" || isStringArray(value)) {
      return value;
    }
  }

  return undefined;
}

function getPath(target: unknown, segments: readonly string[]): unknown {
  let current = target;

  for (const segment of segments) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

export function objectPath(target: unknown, segments: readonly string[]): Record<string, unknown> | undefined {
  const value = getPath(target, segments);
  return isRecord(value) ? value : undefined;
}

export function substituteEnv(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (placeholder, key: string) => env[key] ?? placeholder);
}

export function substituteEnvRecord(value: Record<string, string>, env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    result[key] = substituteEnv(entry, env);
  }

  return result;
}

export function discordChannelSources(value: string[] | string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const entries = Array.isArray(value) ? value : value.split(",");
  const sources = entries.map(normalizeDiscordChannelSource).filter((entry): entry is string => entry !== undefined);
  return sources.length > 0 ? sources : undefined;
}

function normalizeDiscordChannelSource(value: string): string | undefined {
  const entry = value.trim();

  if (entry.length === 0) {
    return undefined;
  }

  return entry.startsWith("channel:") ? entry : `channel:${entry}`;
}

export function parseBoolean(value: unknown): boolean | undefined {
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

export function getBoolean(value: unknown): boolean | undefined {
  return parseBoolean(value);
}

export function isUsableSecret(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("${");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function objectHasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function envToStrings(env: NodeJS.ProcessEnv): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      values[key] = value;
    }
  }

  return values;
}

export function recordToStringMap(value: Record<string, unknown>): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      entries[key] = entry;
    }
  }

  return entries;
}

export function objectConfig(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function stringConfig(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function stringArrayConfig(value: unknown): string[] | undefined {
  return isStringArray(value) ? value : undefined;
}

export function numberConfig(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
