import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { parse as parseYaml } from "yaml";
import {
  defaultCodexAgentConfig,
  defaultEndpointTriggerConfig
} from "./config.js";
import {
  openClawConfigEnvValues,
  openClawShellEnvValues,
  resolveOpenClawConfig,
  type OpenClawConfigResolution
} from "./openclaw-config.js";
import { expandHome, slugifyId } from "./paths.js";
import type { Endpoint, EndpointTriggerConfig } from "./types.js";

export type ImportSource = "hermes" | "openclaw" | "all";

export type ImportCandidate = ReadyImportCandidate | SecretImportCandidate;
export type OpenClawSecretRefSource = "file" | "exec";

export interface ImportCandidateBase {
  source: Exclude<ImportSource, "all">;
  sourceName: string;
  sourcePath: string;
  endpointId: string;
  trigger: EndpointTriggerConfig;
  disabledReason?: string | undefined;
}

export interface ReadyImportCandidate extends ImportCandidateBase {
  kind: "ready";
  token: string;
}

export interface SecretImportCandidate extends ImportCandidateBase {
  kind: "secret";
  secret: OpenClawSecretResolution;
}

export interface OpenClawSecretResolution {
  ref: OpenClawSecretRef;
  provider: OpenClawSecretProvider;
}

export interface OpenClawSecretRef {
  source: "env" | OpenClawSecretRefSource;
  provider: string;
  id: string;
}

export type OpenClawSecretProvider = OpenClawFileSecretProvider | OpenClawExecSecretProvider;

export interface OpenClawFileSecretProvider {
  source: "file";
  path: string;
  mode?: "json" | "singleValue" | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
}

export interface OpenClawExecSecretProvider {
  source: "exec";
  command: string;
  args?: string[] | undefined;
  passEnv?: string[] | undefined;
  env?: Record<string, string> | undefined;
  jsonOnly?: boolean | undefined;
  timeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
}

export interface ImportPlanEntry {
  candidate: ReadyImportCandidate;
  endpointId: string;
  tokenFingerprint: string;
  action: "create" | "skip";
  reason?: string | undefined;
}

export interface ImportDiscoveryOptions {
  env?: NodeJS.ProcessEnv | undefined;
  cwd?: string | undefined;
  hermesHome?: string | undefined;
  openclawHome?: string | undefined;
  openclawConfigPath?: string | undefined;
}

interface SourceEnv {
  values: Record<string, string>;
  paths: string[];
}

const HERMES_TOKEN_PATHS = [
  ["discord", "token"],
  ["discord", "bot_token"],
  ["discord", "botToken"],
  ["gateway", "discord", "token"],
  ["gateway", "discord", "bot_token"],
  ["gateway", "discord", "botToken"],
  ["gateway", "platforms", "discord", "token"],
  ["gateway", "platforms", "discord", "bot_token"],
  ["gateway", "platforms", "discord", "botToken"]
] as const;

const HERMES_FREE_CHANNEL_PATHS = [
  ["discord", "free_response_channels"],
  ["discord", "freeResponseChannels"],
  ["gateway", "platforms", "discord", "free_response_channels"],
  ["gateway", "platforms", "discord", "freeResponseChannels"]
] as const;

const HERMES_REQUIRE_MENTION_PATHS = [
  ["discord", "require_mention"],
  ["discord", "requireMention"],
  ["gateway", "platforms", "discord", "require_mention"],
  ["gateway", "platforms", "discord", "requireMention"]
] as const;

export function discoverImportCandidates(source: ImportSource, options: ImportDiscoveryOptions = {}): ImportCandidate[] {
  switch (source) {
    case "hermes":
      return discoverHermesCandidates(options);
    case "openclaw":
      return discoverOpenClawCandidates(options);
    case "all":
      return [
        ...discoverHermesCandidates(options),
        ...discoverOpenClawCandidates(options)
      ];
  }
}

export function readyImportCandidates(candidates: ImportCandidate[]): ReadyImportCandidate[] {
  return candidates.filter((candidate): candidate is ReadyImportCandidate => candidate.kind === "ready");
}

export async function resolveSecretImportCandidate(
  candidate: SecretImportCandidate,
  options: ImportDiscoveryOptions = {}
): Promise<ReadyImportCandidate> {
  return {
    ...candidate,
    kind: "ready",
    token: await resolveOpenClawSecretCandidate(candidate.secret, options)
  };
}

export function describeSecretImportCandidate(candidate: SecretImportCandidate): string {
  const { ref, provider } = candidate.secret;

  if (provider.source === "file") {
    return `file ${provider.path} (${provider.mode ?? "json"}:${ref.id})`;
  }

  return `exec ${[provider.command, ...(provider.args ?? [])].join(" ")} (${ref.id})`;
}

export function planEndpointImports(existingEndpoints: Endpoint[], candidates: ReadyImportCandidate[]): ImportPlanEntry[] {
  const entries: ImportPlanEntry[] = [];
  const usedIds = new Set(existingEndpoints.map((endpoint) => endpoint.id));
  const existingTokenOwners = new Map<string, string>();
  const plannedTokenOwners = new Map<string, string>();

  for (const endpoint of existingEndpoints) {
    existingTokenOwners.set(tokenFingerprint(endpoint.token), endpoint.id);
  }

  for (const candidate of candidates) {
    const fingerprint = tokenFingerprint(candidate.token);
    const existingOwner = existingTokenOwners.get(fingerprint);

    if (existingOwner) {
      entries.push({
        candidate,
        endpointId: existingOwner,
        tokenFingerprint: fingerprint,
        action: "skip",
        reason: `already imported as ${existingOwner}`
      });
      continue;
    }

    const plannedOwner = plannedTokenOwners.get(fingerprint);

    if (plannedOwner) {
      entries.push({
        candidate,
        endpointId: plannedOwner,
        tokenFingerprint: fingerprint,
        action: "skip",
        reason: `same token as ${plannedOwner}`
      });
      continue;
    }

    const endpointId = nextEndpointId(candidate.endpointId, usedIds);
    usedIds.add(endpointId);
    plannedTokenOwners.set(fingerprint, endpointId);
    entries.push({
      candidate,
      endpointId,
      tokenFingerprint: fingerprint,
      action: "create"
    });
  }

  return entries;
}

export function importPlanEntryEndpoint(entry: ImportPlanEntry): Endpoint {
  return {
    id: entry.endpointId,
    provider: "discord",
    enabled: entry.candidate.disabledReason === undefined,
    token: entry.candidate.token,
    trigger: entry.candidate.trigger,
    agent: defaultCodexAgentConfig()
  };
}

function discoverHermesCandidates(options: ImportDiscoveryOptions): ImportCandidate[] {
  const env = options.env ?? process.env;
  const profileDirs = hermesProfileDirs(options);
  const candidates: ImportCandidate[] = [];

  for (const profile of profileDirs) {
    const profileEnv = readEnvFile(path.join(profile.dir, ".env"));
    const mergedEnv = { ...profileEnv, ...envToStrings(env) };
    const configPath = path.join(profile.dir, "config.yaml");
    const config = readYamlObject(configPath);
    const token = firstStringPath(config, HERMES_TOKEN_PATHS, mergedEnv) ?? mergedEnv.DISCORD_BOT_TOKEN;

    if (!isUsableSecret(token)) {
      continue;
    }

    candidates.push({
      kind: "ready",
      source: "hermes",
      sourceName: profile.name,
      sourcePath: profile.dir,
      endpointId: endpointIdFor("hermes", profile.name),
      token,
      trigger: hermesTriggerConfig(config, mergedEnv)
    });
  }

  return candidates;
}

function hermesProfileDirs(options: ImportDiscoveryOptions): Array<{ name: string; dir: string }> {
  const env = options.env ?? process.env;
  const homeInput = options.hermesHome ?? env.HERMES_HOME;
  const baseHome = expandHome(homeInput ?? "~/.hermes");
  const baseName = homeInput && !options.hermesHome ? hermesProfileName(baseHome) : "default";
  const dirs = new Map<string, { name: string; dir: string }>();

  addHermesProfileDir(dirs, baseName, baseHome);

  const profilesRoot = path.join(baseHome, "profiles");

  if (fs.existsSync(profilesRoot)) {
    for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        addHermesProfileDir(dirs, entry.name, path.join(profilesRoot, entry.name));
      }
    }
  }

  return [...dirs.values()];
}

function addHermesProfileDir(dirs: Map<string, { name: string; dir: string }>, name: string, dir: string): void {
  if (fs.existsSync(dir)) {
    dirs.set(path.resolve(dir), { name, dir });
  }
}

function hermesProfileName(home: string): string {
  const parent = path.basename(path.dirname(home));
  return parent === "profiles" ? path.basename(home) : "default";
}

function hermesTriggerConfig(config: unknown, env: Record<string, string>): EndpointTriggerConfig {
  const defaults = defaultEndpointTriggerConfig();
  const requireMention =
    firstBooleanPath(config, HERMES_REQUIRE_MENTION_PATHS) ??
    parseBoolean(env.DISCORD_REQUIRE_MENTION) ??
    defaults.requireMention;
  const freeResponseSources =
    discordChannelSources(firstStringArrayPath(config, HERMES_FREE_CHANNEL_PATHS) ?? env.DISCORD_FREE_RESPONSE_CHANNELS) ??
    defaults.freeResponseSources;

  return {
    requireMention,
    freeResponseSources
  };
}

function discoverOpenClawCandidates(options: ImportDiscoveryOptions): ImportCandidate[] {
  const openclawConfig = resolveOpenClawConfig(options);
  const config = openclawConfig.config;
  const discord = objectPath(config, ["channels", "discord"]);

  if (discord && getBoolean(discord.enabled) === false) {
    return [];
  }

  const candidates: ImportCandidate[] = [];
  const channelDefaults = objectPath(config, ["channels", "defaults"]);
  const accounts = objectPath(discord, ["accounts"]);
  const defaultAccount = objectPath(accounts, ["default"]);
  const defaultAccountDisabled = Boolean(defaultAccount && getBoolean(defaultAccount.enabled) === false);
  const hasTopLevelToken = Boolean(discord && objectHasOwn(discord, "token"));
  const hasDefaultAccountToken = Boolean(
    defaultAccount &&
    !defaultAccountDisabled &&
    objectHasOwn(defaultAccount, "token")
  );
  const defaultTokenInput = hasDefaultAccountToken ? defaultAccount?.token : discord?.token;
  const hasConfiguredDefaultToken = hasDefaultAccountToken || hasTopLevelToken;
  const env = openClawEnv(options, openclawConfig, openClawTokenEnvKeys({
    accounts,
    config,
    defaultAccountDisabled,
    hasConfiguredDefaultToken,
    defaultTokenInput
  }));
  const defaultToken = resolveOpenClawSecret(defaultTokenInput, env.values, config) ??
    (hasConfiguredDefaultToken ? undefined : env.values.DISCORD_BOT_TOKEN);
  const defaultCandidate = {
    source: "openclaw" as const,
    sourceName: "default",
    sourcePath: openclawConfig.path ?? env.paths[0] ?? openclawConfig.home,
    endpointId: endpointIdFor("openclaw", "default"),
    trigger: defaultEndpointTriggerConfig(),
    disabledReason: openClawAccessControlDisabledReason(channelDefaults, discord, defaultAccount)
  };

  if (!defaultAccountDisabled) {
    if (isUsableSecret(defaultToken)) {
      candidates.push({
        kind: "ready",
        ...defaultCandidate,
        token: defaultToken
      });
    } else {
      const secret = openClawConfirmableSecret(defaultTokenInput, config);

      if (secret) {
        candidates.push({
          kind: "secret",
          ...defaultCandidate,
          secret
        });
      }
    }
  }

  if (accounts) {
    for (const [accountId, account] of Object.entries(accounts)) {
      if (accountId === "default" || !isRecord(account) || getBoolean(account.enabled) === false) {
        continue;
      }

      const token = resolveOpenClawSecret(account.token, env.values, config);

      const baseCandidate = {
        source: "openclaw" as const,
        sourceName: accountId,
        sourcePath: openclawConfig.path ?? env.paths[0] ?? openclawConfig.home,
        endpointId: endpointIdFor("openclaw", accountId),
        trigger: defaultEndpointTriggerConfig(),
        disabledReason: openClawAccessControlDisabledReason(channelDefaults, discord, account)
      };

      if (isUsableSecret(token)) {
        candidates.push({
          kind: "ready",
          ...baseCandidate,
          token
        });
        continue;
      }

      const secret = openClawConfirmableSecret(account.token, config);

      if (secret) {
        candidates.push({
          kind: "secret",
          ...baseCandidate,
          secret
        });
      }
    }
  }

  return candidates;
}

function openClawEnv(
  options: ImportDiscoveryOptions,
  openclawConfig: OpenClawConfigResolution = resolveOpenClawConfig(options),
  shellEnvKeys: Iterable<string> = []
): SourceEnv {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const paths = [
    path.join(os.homedir(), ".config", "openclaw", "gateway.env"),
    path.join(openclawConfig.home, ".env"),
    openclawConfig.path ? path.join(path.dirname(openclawConfig.path), ".env") : undefined,
    path.join(cwd, ".env")
  ].filter((filePath): filePath is string => filePath !== undefined);
  const envPaths = [...new Set(paths)];
  const values: Record<string, string> = {};
  const configEnv = objectPath(openclawConfig.config, ["env"]);

  if (configEnv) {
    Object.assign(values, openClawConfigEnvValues(configEnv));
  }

  for (const filePath of envPaths) {
    Object.assign(values, readEnvFile(filePath));
  }

  Object.assign(values, envToStrings(env));
  Object.assign(values, openClawShellEnvValues({ configEnv, values, keys: shellEnvKeys }));

  return {
    values,
    paths: envPaths.filter((filePath) => fs.existsSync(filePath))
  };
}

function openClawAccessControlDisabledReason(...configs: Array<Record<string, unknown> | undefined>): string | undefined {
  const effectiveConfigs = configs.filter((config): config is Record<string, unknown> => config !== undefined);

  return hasRestrictedOpenClawAccessPolicy(effectiveConfigs) ||
    effectiveConfigs.some(hasOpenClawAccessList)
    ? "OpenClaw access controls need manual review"
    : undefined;
}

function hasRestrictedOpenClawAccessPolicy(configs: Record<string, unknown>[]): boolean {
  return isRestrictedPolicy(openClawEffectiveDmPolicy(configs), ["open", "anyone"]) ||
    isRestrictedPolicy(openClawEffectiveGroupPolicy(configs), ["open"]);
}

function openClawEffectiveDmPolicy(configs: Record<string, unknown>[]): string {
  for (const config of configs.slice().reverse()) {
    const value = stringConfig(config.dmPolicy) ?? stringConfig(objectConfig(config.dm).policy);

    if (value) {
      return value;
    }
  }

  return "pairing";
}

function openClawEffectiveGroupPolicy(configs: Record<string, unknown>[]): string {
  for (const config of configs.slice().reverse()) {
    const value = stringConfig(config.groupPolicy);

    if (value) {
      return value;
    }
  }

  return "allowlist";
}

function hasOpenClawAccessList(config: Record<string, unknown>): boolean {
  const dm = objectConfig(config.dm);
  return isRestrictedAccessList(config.allowFrom) ||
    isRestrictedAccessList(dm.allowFrom) ||
    isRestrictedAccessList(config.groupAllowFrom) ||
    isRestrictedAccessList(config.guildAllowFrom) ||
    isRestrictedAccessList(config.allowedGuilds) ||
    isRestrictedAccessList(config.allowedUsers) ||
    hasSpecificGuildConfig(objectConfig(config.guilds));
}

function isRestrictedPolicy(value: string, openValues: string[]): boolean {
  return !openValues.includes(value.trim().toLowerCase());
}

function isRestrictedAccessList(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim() !== "*";
  }

  if (!Array.isArray(value)) {
    return false;
  }

  return !value.some((entry) => String(entry).trim() === "*");
}

function hasSpecificGuildConfig(guilds: Record<string, unknown>): boolean {
  return Object.keys(guilds).some((guildId) => guildId !== "*");
}

function openClawTokenEnvKeys(params: {
  accounts: Record<string, unknown> | undefined;
  config: unknown;
  defaultAccountDisabled: boolean;
  hasConfiguredDefaultToken: boolean;
  defaultTokenInput: unknown;
}): string[] {
  const keys = new Set<string>();

  if (!params.defaultAccountDisabled) {
    addOpenClawTokenEnvKeys(keys, params.defaultTokenInput, params.config);

    if (!params.hasConfiguredDefaultToken) {
      keys.add("DISCORD_BOT_TOKEN");
    }
  }

  if (params.accounts) {
    for (const [accountId, account] of Object.entries(params.accounts)) {
      if (accountId !== "default" && isRecord(account) && getBoolean(account.enabled) !== false) {
        addOpenClawTokenEnvKeys(keys, account.token, params.config);
      }
    }
  }

  return [...keys];
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

function resolveOpenClawSecret(value: unknown, env: Record<string, string>, config?: unknown): string | undefined {
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

function openClawConfirmableSecret(value: unknown, config: unknown): OpenClawSecretResolution | undefined {
  const ref = openClawSecretRef(value, config);

  if (!ref || ref.source === "env") {
    return undefined;
  }

  const provider = openClawSecretProvider(ref, config);

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

function openClawSecretProvider(ref: OpenClawSecretRef, config: unknown): OpenClawSecretProvider | undefined {
  const providers = objectPath(config, ["secrets", "providers"]);
  const provider = providers?.[ref.provider];

  if (!isRecord(provider) || provider.source !== ref.source) {
    return undefined;
  }

  if (ref.source === "file" && typeof provider.path === "string") {
    return {
      source: "file",
      path: provider.path,
      mode: provider.mode === "singleValue" ? "singleValue" : "json",
      timeoutMs: numberConfig(provider.timeoutMs),
      maxBytes: numberConfig(provider.maxBytes)
    };
  }

  if (ref.source === "exec" && typeof provider.command === "string") {
    return {
      source: "exec",
      command: provider.command,
      args: stringArrayConfig(provider.args),
      passEnv: stringArrayConfig(provider.passEnv),
      env: recordToStringMap(objectConfig(provider.env)),
      jsonOnly: typeof provider.jsonOnly === "boolean" ? provider.jsonOnly : undefined,
      timeoutMs: numberConfig(provider.timeoutMs),
      maxOutputBytes: numberConfig(provider.maxOutputBytes)
    };
  }

  return undefined;
}

async function resolveOpenClawSecretCandidate(
  secret: OpenClawSecretResolution,
  options: ImportDiscoveryOptions
): Promise<string> {
  switch (secret.provider.source) {
    case "file":
      return resolveOpenClawFileSecret(secret.ref, secret.provider);
    case "exec":
      return resolveOpenClawExecSecret(secret.ref, secret.provider, options.env ?? process.env);
  }
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

  if (!params.jsonOnly) {
    try {
      return parseOpenClawExecJsonOutput(JSON.parse(trimmed), params.id, params.jsonOnly);
    } catch {
      return trimmed;
    }
  }

  return parseOpenClawExecJsonOutput(JSON.parse(trimmed), params.id, params.jsonOnly);
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

function readJsonPointer(target: unknown, pointer: string): unknown {
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

function normalizeSecretString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`SecretRef ${label} resolved to an empty or non-string value.`);
  }

  return value.trim();
}

function endpointIdFor(source: Exclude<ImportSource, "all">, sourceName: string): string {
  const base = sourceName === "default" ? source : `${source}-${sourceName}`;
  return slugifyId(base);
}

function nextEndpointId(baseId: string, usedIds: Set<string>): string {
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

function tokenFingerprint(token: string): string {
  return `sha256:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

function readYamlObject(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  const content = fs.readFileSync(filePath, "utf8").trim();
  return content.length > 0 ? parseYaml(content) : undefined;
}

function readEnvFile(filePath: string): Record<string, string> {
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

function firstStringPath(
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

function firstBooleanPath(target: unknown, paths: readonly (readonly string[])[]): boolean | undefined {
  for (const candidatePath of paths) {
    const parsed = parseBoolean(getPath(target, candidatePath));

    if (parsed !== undefined) {
      return parsed;
    }
  }

  return undefined;
}

function firstStringArrayPath(target: unknown, paths: readonly (readonly string[])[]): string[] | string | undefined {
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

function objectPath(target: unknown, segments: readonly string[]): Record<string, unknown> | undefined {
  const value = getPath(target, segments);
  return isRecord(value) ? value : undefined;
}

function substituteEnv(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (placeholder, key: string) => env[key] ?? placeholder);
}

function discordChannelSources(value: string[] | string | undefined): string[] | undefined {
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

function isUsableSecret(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("${");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectHasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function envToStrings(env: NodeJS.ProcessEnv): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      values[key] = value;
    }
  }

  return values;
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

function stringConfig(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayConfig(value: unknown): string[] | undefined {
  return isStringArray(value) ? value : undefined;
}

function numberConfig(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
