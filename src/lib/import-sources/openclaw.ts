import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultEndpointTriggerConfig } from "../config.js";
import {
  openClawConfigEnvValues,
  resolveOpenClawConfig,
  type OpenClawConfigResolution
} from "../openclaw-config.js";
import {
  envToStrings,
  endpointIdFor,
  getBoolean,
  isRecord,
  isUsableSecret,
  objectHasOwn,
  objectPath,
  readEnvFile
} from "./helpers.js";
import { openClawAccessControlDisabledReason } from "./openclaw-access.js";
import {
  openClawConfirmableSecret,
  openClawConfirmableShellEnvSecret,
  resolveOpenClawSecret
} from "./openclaw-secrets.js";
import type { ImportCandidate, ImportDiscoveryOptions, SourceEnv } from "./types.js";

export function discoverOpenClawCandidates(options: ImportDiscoveryOptions): ImportCandidate[] {
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
  const env = openClawEnv(options, openclawConfig);
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
      const secret = openClawConfirmableSecret(defaultTokenInput, config, env.values) ??
        openClawConfirmableShellEnvSecret({
          tokenInput: defaultTokenInput,
          fallbackKey: hasConfiguredDefaultToken ? undefined : "DISCORD_BOT_TOKEN",
          config,
          env
        });

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

      const secret = openClawConfirmableSecret(account.token, config, env.values) ??
        openClawConfirmableShellEnvSecret({
          tokenInput: account.token,
          config,
          env
        });

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
  openclawConfig: OpenClawConfigResolution = resolveOpenClawConfig(options)
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

  return {
    values,
    paths: envPaths.filter((filePath) => fs.existsSync(filePath))
  };
}
