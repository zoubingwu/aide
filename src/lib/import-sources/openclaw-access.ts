import { getBoolean, objectConfig, stringConfig } from "./helpers.js";

export function openClawAccessControlDisabledReason(...configs: Array<Record<string, unknown> | undefined>): string | undefined {
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
