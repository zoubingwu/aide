import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { openClawShellEnvValues, planOpenClawShellEnv } from "../openclaw-config.js";
import { expandHome } from "../paths.js";
import {
  getBoolean,
  isRecord,
  normalizeSecretString,
  numberConfig,
  objectConfig,
  objectPath,
  readJsonPointer,
  recordToStringMap,
  stringArrayConfig,
  substituteEnv,
  substituteEnvRecord
} from "./helpers.js";
import type {
  ImportDiscoveryOptions,
  OpenClawExecSecretProvider,
  OpenClawFileSecretProvider,
  OpenClawSecretProvider,
  OpenClawSecretRef,
  OpenClawSecretResolution,
  OpenClawShellEnvSecretProvider,
  SourceEnv
} from "./types.js";

function openClawTokenInputEnvKeys(value: unknown, config: unknown): string[] {
  const keys = new Set<string>();
  addOpenClawTokenEnvKeys(keys, value, config);
  return [...keys];
}

export function openClawConfirmableShellEnvSecret(params: {
  tokenInput: unknown;
  fallbackKey?: string | undefined;
  config: unknown;
  env: SourceEnv;
}): OpenClawSecretResolution | undefined {
  const configEnv = objectPath(params.config, ["env"]);
  const keys = openClawTokenInputEnvKeys(params.tokenInput, params.config);

  if (params.fallbackKey) {
    keys.push(params.fallbackKey);
  }

  const plan = planOpenClawShellEnv({ configEnv, values: params.env.values, keys });

  if (!plan) {
    return undefined;
  }

  return {
    ref: {
      source: "env",
      provider: "shellEnv",
      id: plan.keys.join(",")
    },
    provider: {
      source: "shellEnv",
      keys: plan.keys,
      command: plan.command,
      values: params.env.values,
      configEnv,
      tokenInput: params.tokenInput,
      fallbackKey: params.fallbackKey,
      config: params.config
    }
  };
}

function addOpenClawTokenEnvKeys(keys: Set<string>, value: unknown, config: unknown): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\$\{([A-Z][A-Z0-9_]{0,127})\}/g)) {
      keys.add(match[1] ?? "");
    }

    keys.delete("");
    return;
  }

  const ref = openClawSecretRef(value, config);

  if (ref?.source === "env" && openClawEnvSecretAllowed(ref, config)) {
    keys.add(ref.id);
  }
}

export function resolveOpenClawSecret(value: unknown, env: Record<string, string>, config?: unknown): string | undefined {
  if (typeof value === "string") {
    return substituteEnv(value, env);
  }

  const ref = openClawSecretRef(value, config);

  if (!ref || ref.source !== "env" || !openClawEnvSecretAllowed(ref, config)) {
    return undefined;
  }

  return env[ref.id];
}

function openClawEnvSecretAllowed(ref: OpenClawSecretRef, config: unknown): boolean {
  const providers = objectPath(config, ["secrets", "providers"]);
  const provider = providers?.[ref.provider];

  if (!isRecord(provider)) {
    return ref.provider === openClawDefaultSecretProvider(config, "env");
  }

  if (provider.source !== "env") {
    return false;
  }

  const allowlist = stringArrayConfig(provider.allowlist);
  return !allowlist || allowlist.includes(ref.id);
}

export function openClawConfirmableSecret(
  value: unknown,
  config: unknown,
  env: Record<string, string>
): OpenClawSecretResolution | undefined {
  const ref = openClawSecretRef(value, config);

  if (!ref || ref.source === "env") {
    return undefined;
  }

  const provider = openClawSecretProvider(ref, config, env);

  if (!provider) {
    return undefined;
  }

  return { ref, provider };
}

function openClawSecretRef(value: unknown, config?: unknown): OpenClawSecretRef | undefined {
  if (!isRecord(value) || typeof value.source !== "string" || typeof value.id !== "string") {
    return undefined;
  }

  if (!["env", "file", "exec"].includes(value.source)) {
    return undefined;
  }

  const provider = typeof value.provider === "string" && value.provider.trim()
    ? value.provider.trim()
    : openClawDefaultSecretProvider(config, value.source as OpenClawSecretRef["source"]);

  return {
    source: value.source as OpenClawSecretRef["source"],
    provider,
    id: value.id.trim()
  };
}

function openClawDefaultSecretProvider(config: unknown, source: OpenClawSecretRef["source"]): string {
  const defaults = objectPath(config, ["secrets", "defaults"]);
  const value = defaults?.[source];
  return typeof value === "string" && value.trim() ? value.trim() : "default";
}

function openClawSecretProvider(
  ref: OpenClawSecretRef,
  config: unknown,
  env: Record<string, string>
): OpenClawSecretProvider | undefined {
  const providers = objectPath(config, ["secrets", "providers"]);
  const provider = providers?.[ref.provider];

  if (!isRecord(provider) || provider.source !== ref.source) {
    return undefined;
  }

  if (ref.source === "file" && typeof provider.path === "string") {
    return {
      source: "file",
      path: substituteEnv(provider.path, env),
      mode: provider.mode === "singleValue" ? "singleValue" : "json",
      timeoutMs: numberConfig(provider.timeoutMs),
      maxBytes: numberConfig(provider.maxBytes)
    };
  }

  if (ref.source === "exec" && typeof provider.command === "string") {
    return {
      source: "exec",
      command: substituteEnv(provider.command, env),
      args: stringArrayConfig(provider.args)?.map((arg) => substituteEnv(arg, env)),
      passEnv: stringArrayConfig(provider.passEnv),
      env: substituteEnvRecord(recordToStringMap(objectConfig(provider.env)), env),
      jsonOnly: typeof provider.jsonOnly === "boolean" ? provider.jsonOnly : undefined,
      timeoutMs: numberConfig(provider.timeoutMs),
      maxOutputBytes: numberConfig(provider.maxOutputBytes)
    };
  }

  return undefined;
}

export async function resolveOpenClawSecretCandidate(
  secret: OpenClawSecretResolution,
  options: ImportDiscoveryOptions
): Promise<string> {
  switch (secret.provider.source) {
    case "file":
      return resolveOpenClawFileSecret(secret.ref, secret.provider);
    case "exec":
      return resolveOpenClawExecSecret(secret.ref, secret.provider, options.env ?? process.env);
    case "shellEnv":
      return resolveOpenClawShellEnvSecret(secret.provider);
  }
}

function resolveOpenClawShellEnvSecret(provider: OpenClawShellEnvSecretProvider): string {
  const env = {
    ...provider.values,
    ...openClawShellEnvValues({
      configEnv: provider.configEnv,
      values: provider.values,
      keys: provider.keys
    })
  };
  const token = provider.tokenInput === undefined && provider.fallbackKey
    ? env[provider.fallbackKey]
    : resolveOpenClawSecret(provider.tokenInput, env, provider.config);

  return normalizeSecretString(token, `shellEnv:${provider.keys.join(",")}`);
}

function resolveOpenClawFileSecret(ref: OpenClawSecretRef, provider: OpenClawFileSecretProvider): string {
  if ((provider.mode ?? "json") === "singleValue" && ref.id !== "value") {
    throw new Error(`singleValue file SecretRef expects id "value": ${ref.id}`);
  }

  const buffer = fs.readFileSync(expandHome(provider.path));

  if (provider.maxBytes !== undefined && buffer.byteLength > provider.maxBytes) {
    throw new Error(`File SecretRef exceeded maxBytes (${provider.maxBytes}).`);
  }

  const content = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const mode = provider.mode ?? "json";
  const resolved = mode === "singleValue" ? content.replace(/\r?\n$/, "") : readJsonPointer(JSON.parse(content), ref.id);
  return normalizeSecretString(resolved, `file:${ref.provider}:${ref.id}`);
}

async function resolveOpenClawExecSecret(
  ref: OpenClawSecretRef,
  provider: OpenClawExecSecretProvider,
  env: NodeJS.ProcessEnv
): Promise<string> {
  const command = expandHome(provider.command);
  const childEnv: NodeJS.ProcessEnv = {};

  for (const key of provider.passEnv ?? []) {
    const value = env[key];

    if (value !== undefined) {
      childEnv[key] = value;
    }
  }

  Object.assign(childEnv, provider.env);

  const result = await execa(command, provider.args ?? [], {
    cwd: path.dirname(command),
    env: childEnv,
    extendEnv: false,
    input: JSON.stringify({
      protocolVersion: 1,
      provider: ref.provider,
      ids: [ref.id]
    }),
    maxBuffer: provider.maxOutputBytes ?? 1024 * 1024,
    timeout: provider.timeoutMs ?? 5_000,
    windowsHide: true
  });

  return normalizeSecretString(
    parseOpenClawExecOutput({
      stdout: result.stdout,
      id: ref.id,
      jsonOnly: provider.jsonOnly ?? true
    }),
    `exec:${ref.provider}:${ref.id}`
  );
}

function parseOpenClawExecOutput(params: { stdout: string; id: string; jsonOnly: boolean }): unknown {
  const trimmed = params.stdout.trim();

  try {
    return parseOpenClawExecJsonOutput(JSON.parse(trimmed), params.id, params.jsonOnly);
  } catch (error) {
    if (!params.jsonOnly && error instanceof SyntaxError) {
      return trimmed;
    }

    throw error;
  }
}

function parseOpenClawExecJsonOutput(parsed: unknown, id: string, jsonOnly: boolean): unknown {
  if (!isRecord(parsed)) {
    if (!jsonOnly && typeof parsed === "string") {
      return parsed;
    }

    throw new Error("Exec SecretRef response must be a JSON object.");
  }

  if (parsed.protocolVersion !== 1) {
    throw new Error("Exec SecretRef protocolVersion must be 1.");
  }

  const values = objectConfig(parsed.values);
  const errors = objectConfig(parsed.errors);

  if (errors[id]) {
    const error = errors[id];
    const message = isRecord(error) && typeof error.message === "string" ? error.message : "unknown error";
    throw new Error(`Exec SecretRef failed for ${id}: ${message}`);
  }

  if (!(id in values)) {
    throw new Error(`Exec SecretRef response missing id: ${id}`);
  }

  return values[id];
}
