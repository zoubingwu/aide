import fs from "node:fs";
import path from "node:path";
import { envKeySegment } from "./paths.js";
import type { Endpoint } from "./types.js";

export function discordTokenEnvKey(endpointId: string): string {
  return `AIDE_DISCORD_TOKEN_${envKeySegment(endpointId)}`;
}

export function resolveDiscordToken(home: string, endpoint: Endpoint): string | undefined {
  const env = readEnvLocal(home);
  const endpointKey = discordTokenEnvKey(endpoint.id);

  return process.env[endpointKey] ?? process.env.DISCORD_BOT_TOKEN ?? env[endpointKey] ?? env.DISCORD_BOT_TOKEN;
}

export function writeDiscordToken(home: string, endpointId: string, token: string): string {
  const key = discordTokenEnvKey(endpointId);
  const env = readEnvLocal(home);
  env[key] = token;
  writeEnvLocal(home, env);
  return key;
}

export function readEnvLocal(home: string): Record<string, string> {
  const filePath = envLocalPath(home);

  if (!fs.existsSync(filePath)) {
    return {};
  }

  const result: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");

    if (equalsIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    result[key] = unquoteEnvValue(rawValue);
  }

  return result;
}

function writeEnvLocal(home: string, env: Record<string, string>): void {
  fs.mkdirSync(home, { recursive: true });
  const content = Object.entries(env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${quoteEnvValue(value)}`)
    .join("\n");

  fs.writeFileSync(envLocalPath(home), `${content}\n`, { mode: 0o600 });
}

function envLocalPath(home: string): string {
  return path.join(home, ".env.local");
}

function quoteEnvValue(value: string): string {
  if (/^[A-Za-z0-9._:/+=@-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }

  return value;
}
