import {
  ApplicationCommandType,
  type ApplicationCommandDataResolvable,
  type ChatInputCommandInteraction,
  type Client,
  type InteractionReplyOptions,
  type Interaction
} from "discord.js";
import { loadEndpoints, requireEndpointIndex, writeEndpoints } from "./config.js";
import { chunkDiscordMessage } from "./discord-message-chunks.js";
import { statusLabel } from "./format.js";
import { appendActivityLog, endpointActivity } from "./logging.js";
import { runtimeDisplayStatus } from "./runtime-state.js";
import { loadSchedules } from "./schedules.js";
import type { AgentOutputMode, Endpoint, Schedule } from "./types.js";

const DISCORD_COMMAND_GUILD_ID_ENV = "AIDE_DISCORD_COMMAND_GUILD_ID";
const SUPPRESSED_ALLOWED_MENTIONS = { parse: [] } satisfies NonNullable<InteractionReplyOptions["allowedMentions"]>;

const AIDE_DISCORD_COMMANDS: ApplicationCommandDataResolvable[] = [
  {
    name: "stop",
    description: "Cancel the active Aide run in this conversation.",
    type: ApplicationCommandType.ChatInput
  },
  {
    name: "verbose",
    description: "Toggle Aide output between concise and verbose.",
    type: ApplicationCommandType.ChatInput
  },
  {
    name: "status",
    description: "Show Aide endpoint status for this conversation.",
    type: ApplicationCommandType.ChatInput
  },
  {
    name: "schedule",
    description: "Inspect Aide schedules.",
    type: ApplicationCommandType.ChatInput
  },
  {
    name: "help",
    description: "List supported Aide Discord commands.",
    type: ApplicationCommandType.ChatInput
  }
];

const AIDE_DISCORD_COMMAND_NAMES = new Set(["stop", "verbose", "status", "schedule", "help"]);
const activeDiscordRuns = new Map<string, Set<AbortController>>();

export function discordApplicationCommands(): ApplicationCommandDataResolvable[] {
  return AIDE_DISCORD_COMMANDS;
}

export async function registerDiscordCommands(home: string, endpoint: Endpoint, client: Client): Promise<void> {
  if (!client.application) {
    throw new Error("Discord application is unavailable after login.");
  }

  const guildId = discordCommandGuildId();
  if (guildId) {
    await client.application.commands.set(AIDE_DISCORD_COMMANDS, guildId);
  } else {
    await client.application.commands.set(AIDE_DISCORD_COMMANDS);
  }
  appendActivityLog(
    home,
    endpointActivity(home, endpoint, "discord_commands_registered", {
      scope: guildId ? "guild" : "global",
      guildId
    })
  );
}

export async function handleDiscordInteraction(home: string, endpoint: Endpoint, interaction: Interaction): Promise<void> {
  if (!endpoint.enabled || !interaction.isChatInputCommand() || interaction.user.bot) {
    return;
  }

  if (!AIDE_DISCORD_COMMAND_NAMES.has(interaction.commandName)) {
    return;
  }

  const source = discordInteractionSource(interaction);
  appendActivityLog(
    home,
    endpointActivity(home, endpoint, "discord_command_received", {
      command: interaction.commandName,
      source
    })
  );

  try {
    await runDiscordCommand(home, endpoint, interaction, source);
  } catch (error) {
    appendActivityLog(
      home,
      endpointActivity(home, endpoint, "discord_command_failed", {
        command: interaction.commandName,
        source,
        error: errorMessage(error)
      })
    );
    await replyInteraction(interaction, `Aide command failed: ${errorMessage(error)}`);
  }
}

export function trackActiveDiscordRun(endpoint: Endpoint, source: string): { signal: AbortSignal; finish(): void } {
  const controller = new AbortController();
  const key = activeDiscordRunKey(endpoint, source);
  const runs = activeDiscordRuns.get(key) ?? new Set<AbortController>();

  runs.add(controller);
  activeDiscordRuns.set(key, runs);

  return {
    signal: controller.signal,
    finish() {
      runs.delete(controller);

      if (runs.size === 0) {
        activeDiscordRuns.delete(key);
      }
    }
  };
}

async function runDiscordCommand(
  home: string,
  endpoint: Endpoint,
  interaction: ChatInputCommandInteraction,
  source: string
): Promise<void> {
  switch (interaction.commandName) {
    case "stop": {
      const stopped = stopActiveDiscordRuns(endpoint, source);
      await replyInteraction(interaction, stopped ? "Stopped active Aide run." : "This conversation is idle.");
      return;
    }
    case "verbose": {
      const mode = toggleEndpointOutputMode(home, endpoint);
      await replyInteraction(interaction, `Output mode is now ${mode}.`);
      return;
    }
    case "status":
      await replyInteraction(interaction, discordStatusText(home, endpoint, source));
      return;
    case "schedule":
      await replyInteraction(interaction, discordScheduleListText(home, endpoint, source));
      return;
    case "help":
      await replyInteraction(interaction, discordHelpText());
      return;
  }
}

function discordCommandGuildId(): string | undefined {
  const guildId = process.env[DISCORD_COMMAND_GUILD_ID_ENV]?.trim();
  return guildId ? guildId : undefined;
}

function discordInteractionSource(interaction: ChatInputCommandInteraction): string {
  return interaction.guildId ? `channel:${interaction.channelId}` : `user:${interaction.user.id}`;
}

function activeDiscordRunKey(endpoint: Endpoint, source: string): string {
  return `${endpoint.id}:${source}`;
}

function stopActiveDiscordRuns(endpoint: Endpoint, source: string): boolean {
  const runs = activeDiscordRuns.get(activeDiscordRunKey(endpoint, source));

  if (!runs || runs.size === 0) {
    return false;
  }

  for (const controller of runs) {
    controller.abort();
  }

  return true;
}

function hasActiveDiscordRun(endpoint: Endpoint, source: string): boolean {
  return (activeDiscordRuns.get(activeDiscordRunKey(endpoint, source))?.size ?? 0) > 0;
}

function toggleEndpointOutputMode(home: string, endpoint: Endpoint): AgentOutputMode {
  const endpoints = loadEndpoints(home);
  const index = requireEndpointIndex(endpoints, endpoint.id);
  const current = endpoints[index];

  if (!current) {
    throw new Error(`Endpoint not found: ${endpoint.id}`);
  }

  const outputMode = nextOutputMode(current.agent.outputMode);
  endpoints[index] = {
    ...current,
    agent: {
      ...current.agent,
      outputMode
    }
  };
  writeEndpoints(home, endpoints);
  endpoint.agent.outputMode = outputMode;
  return outputMode;
}

function nextOutputMode(mode: AgentOutputMode): AgentOutputMode {
  return mode === "concise" ? "verbose" : "concise";
}

function discordStatusText(home: string, endpoint: Endpoint, source: string): string {
  const runtime = runtimeDisplayStatus(home);
  const pid = runtime.pid ? ` PID ${runtime.pid}` : "";
  return [
    `Endpoint: ${endpoint.id} (${endpoint.enabled ? "enabled" : "paused"})`,
    `Runtime: ${runtime.status}${pid}`,
    `Output: ${endpoint.agent.outputMode}`,
    `Active run: ${hasActiveDiscordRun(endpoint, source) ? "active" : "idle"}`
  ].join("\n");
}

function discordScheduleListText(home: string, endpoint: Endpoint, source: string): string {
  const schedules = loadSchedules(home).filter((schedule) => schedule.endpoint === endpoint.id && schedule.target === source);

  if (schedules.length === 0) {
    return `No schedules configured for ${source}.`;
  }

  return [`Schedules for ${source}:`, "", schedules.map(discordScheduleText).join("\n\n")].join("\n");
}

function discordScheduleText(schedule: Schedule): string {
  return [
    `${schedule.id} (${statusLabel(schedule.enabled)})`,
    `Time: ${scheduleTimeText(schedule)}`,
    `Prompt: ${schedule.message}`
  ].join("\n");
}

function scheduleTimeText(schedule: Schedule): string {
  switch (schedule.kind) {
    case "cron":
      return `cron ${schedule.cron}${timezoneText(schedule)}`;
    case "hourly":
      return `hourly at minute ${schedule.minute}${timezoneText(schedule)}`;
    case "daily":
      return `daily at ${schedule.time}${timezoneText(schedule)}`;
    case "weekly":
      return `weekly on ${schedule.weekday} at ${schedule.time}${timezoneText(schedule)}`;
    case "biweekly":
      return `biweekly on ${schedule.weekday} at ${schedule.time}, starting ${schedule.startDate}${timezoneText(schedule)}`;
    case "monthly":
      return `monthly on day ${schedule.day} at ${schedule.time}${timezoneText(schedule)}`;
    case "once":
      return `once at ${schedule.runAt}`;
  }
}

function timezoneText(schedule: Schedule): string {
  return schedule.timezone ? ` (${schedule.timezone})` : "";
}

function discordHelpText(): string {
  return [
    "Aide Discord commands:",
    "/stop - cancel the active run in this conversation",
    "/verbose - toggle concise or verbose output",
    "/status - show endpoint status and active run state",
    "/schedule - list schedules for this conversation",
    "/help - show this command list"
  ].join("\n");
}

async function replyInteraction(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  const chunks = chunkDiscordMessage(content);

  if (interaction.deferred || interaction.replied) {
    for (const chunk of chunks) {
      await interaction.followUp({ content: chunk, allowedMentions: SUPPRESSED_ALLOWED_MENTIONS });
    }
    return;
  }

  const [firstChunk, ...remainingChunks] = chunks;
  await interaction.reply({ content: firstChunk ?? "", allowedMentions: SUPPRESSED_ALLOWED_MENTIONS });

  for (const chunk of remainingChunks) {
    await interaction.followUp({ content: chunk, allowedMentions: SUPPRESSED_ALLOWED_MENTIONS });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
