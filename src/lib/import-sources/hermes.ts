import fs from "node:fs";
import path from "node:path";
import { defaultEndpointTriggerConfig } from "../config.js";
import { expandHome } from "../paths.js";
import type { EndpointTriggerConfig } from "../types.js";
import {
  discordChannelSources,
  envToStrings,
  firstBooleanPath,
  firstStringArrayPath,
  firstStringPath,
  isUsableSecret,
  parseBoolean,
  readEnvFile,
  readYamlObject,
  endpointIdFor
} from "./helpers.js";
import type { ImportCandidate, ImportDiscoveryOptions } from "./types.js";

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


export function discoverHermesCandidates(options: ImportDiscoveryOptions): ImportCandidate[] {
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
      provider: "discord",
      sourceChannel: "discord",
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
