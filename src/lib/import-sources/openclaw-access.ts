const OPENCLAW_DISCORD_ACCESS_FIELDS = [
  { path: ["dmPolicy"], label: "dmPolicy" },
  { path: ["dm", "policy"], label: "dm.policy" },
  { path: ["allowFrom"], label: "allowFrom" },
  { path: ["dm", "allowFrom"], label: "dm.allowFrom" },
  { path: ["groupPolicy"], label: "groupPolicy" },
  { path: ["groupAllowFrom"], label: "groupAllowFrom" },
  { path: ["guildAllowFrom"], label: "guildAllowFrom" },
  { path: ["allowedGuilds"], label: "allowedGuilds" },
  { path: ["allowedUsers"], label: "allowedUsers" },
  { path: ["guilds"], label: "guilds" }
] as const;

export function openClawAccessControlWarning(...configs: Array<Record<string, unknown> | undefined>): string | undefined {
  const fields = [
    ...new Set(
      configs
        .filter((config): config is Record<string, unknown> => config !== undefined)
        .flatMap(openClawDiscordAccessFields)
    )
  ];

  return fields.length > 0
    ? `Aide uses its Discord trigger settings for OpenClaw access fields: ${fields.join(", ")}`
    : undefined;
}

function openClawDiscordAccessFields(config: Record<string, unknown>): string[] {
  return OPENCLAW_DISCORD_ACCESS_FIELDS
    .filter((field) => hasObjectPath(config, field.path))
    .map((field) => field.label);
}

function hasObjectPath(target: Record<string, unknown>, segments: readonly string[]): boolean {
  let current: unknown = target;

  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return false;
    }

    current = current[segment];
  }

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
