import { GatewayIntentBits, type Message } from "discord.js";
import { formatAgentProgress } from "./agent-progress.js";
import { handleAssistantRequest } from "./assistant.js";
import { trackActiveDiscordRun } from "./discord-commands.js";
import { buildDiscordPromptMetadata, buildDiscordRequestContext } from "./discord-context.js";
import { startDiscordContextToolServer } from "./discord-context-mcp.js";
import { chunkDiscordMessage } from "./discord-message-chunks.js";
import { appendActivityLog, endpointActivity } from "./logging.js";
import {
  clearDeferredRuntimeRestart,
  consumeDeferredRuntimeRestart,
  startDeferredRuntimeRestart
} from "./runtime-restart.js";
import type { AgentRunEvent, ManagedAgentToolServer } from "./agent-tools.js";
import type { AgentRunResult, Endpoint } from "./types.js";

const DISCORD_TYPING_REFRESH_MS = 8_000;
const EMPTY_SUCCESS_REACTION = "✅";
const EMPTY_SUCCESS_REACTION_FALLBACK = "Done.";

export function discordGatewayIntents(endpoint: Endpoint): GatewayIntentBits[] {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages
  ];

  if (requiresMessageContentIntent(endpoint)) {
    intents.push(GatewayIntentBits.MessageContent);
  }

  return intents;
}

export async function handleDiscordMessage(home: string, endpoint: Endpoint, message: Message): Promise<void> {
  if (!endpoint.enabled || message.author.bot || !message.client.user) {
    return;
  }

  const botUserId = message.client.user.id;

  if (!shouldTriggerDiscordMessage(endpoint, message, botUserId)) {
    return;
  }

  const content = stripMention(message.content, botUserId).trim();

  if (content.length === 0) {
    return;
  }

  appendActivityLog(home, endpointActivity(home, endpoint, "discord_message_received", { author: message.author.username }));
  const discordContext = buildDiscordRequestContext(endpoint, message);
  const toolServer = await startDiscordContextTools(home, endpoint, message, discordContext);
  const progressReporter = discordProgressReporter(endpoint, message);
  const activeRun = trackActiveDiscordRun(endpoint, discordContext.source);

  const result = await (async () => {
    try {
      return await withDiscordTyping(message.channel, () =>
        handleAssistantRequest(home, endpoint, content, message.author.username, {
          source: discordContext.source,
          metadata: buildDiscordPromptMetadata(discordContext),
          toolServers: toolServer ? [{ name: toolServer.name, url: toolServer.url }] : undefined,
          abortSignal: activeRun.signal,
          ...(progressReporter ? { onEvent: progressReporter } : {})
        })
      );
    } finally {
      activeRun.finish();
      await toolServer?.stop();
    }
  })();

  if (result.cancelled) {
    clearDeferredRuntimeRestart(home);
    appendActivityLog(home, endpointActivity(home, endpoint, "discord_agent_cancelled", { source: discordContext.source }));
    return;
  }

  if (result.exitCode !== 0) {
    appendActivityLog(home, endpointActivity(home, endpoint, "agent_response_failed", { exitCode: result.exitCode }));
  }

  try {
    await deliverDiscordResponse(home, endpoint, message, result);
  } catch (error) {
    clearDeferredRuntimeRestart(home);
    appendActivityLog(
      home,
      endpointActivity(home, endpoint, "discord_delivery_failed", {
        exitCode: result.exitCode,
        error: errorMessage(error)
      })
    );
    throw error;
  }

  restartRuntimeAfterDeliveredResponse(home);
}

export function discordMessageSource(message: { author: { id: string }; channelId: string; guildId: string | null }): string {
  return message.guildId ? `channel:${message.channelId}` : `user:${message.author.id}`;
}

async function withDiscordTyping<T>(channel: Message["channel"], task: () => Promise<T>): Promise<T> {
  const sendTyping = typingSender(channel);

  if (!sendTyping) {
    return task();
  }

  await sendTyping();

  const timer = setInterval(() => {
    void Promise.resolve(sendTyping()).catch(() => undefined);
  }, DISCORD_TYPING_REFRESH_MS);

  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}

function typingSender(channel: Message["channel"]): (() => Promise<void>) | undefined {
  if ("sendTyping" in channel && typeof channel.sendTyping === "function") {
    return () => channel.sendTyping();
  }

  return undefined;
}

function stripMention(content: string, botUserId: string): string {
  return content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
}

function shouldTriggerDiscordMessage(endpoint: Endpoint, message: Message, botUserId: string): boolean {
  if (!message.guildId) {
    return true;
  }

  if (!endpoint.trigger.requireMention || isFreeResponseMessage(endpoint, message)) {
    return true;
  }

  return message.mentions.users.has(botUserId);
}

function requiresMessageContentIntent(endpoint: Endpoint): boolean {
  return !endpoint.trigger.requireMention || endpoint.trigger.freeResponseSources.length > 0;
}

function isFreeResponseMessage(endpoint: Endpoint, message: Message): boolean {
  const sources = new Set(endpoint.trigger.freeResponseSources);

  for (const source of discordChannelSources(message)) {
    if (sources.has(source)) {
      return true;
    }
  }

  return false;
}

function discordChannelSources(message: Message): string[] {
  const channelIds = [message.channelId, discordParentChannelId(message)].filter(Boolean);
  return [...new Set(channelIds)].map((id) => `channel:${id}`);
}

function discordParentChannelId(message: Message): string | undefined {
  const channel = message.channel as Message["channel"] & { parentId?: string | null };
  return channel.parentId ?? undefined;
}

async function sendResponse(message: Message, response: string): Promise<void> {
  const chunks = chunkDiscordMessage(response);

  for (const chunk of chunks) {
    await message.reply({ content: chunk });
  }
}

function discordProgressReporter(endpoint: Endpoint, message: Message): ((event: AgentRunEvent) => Promise<void>) | undefined {
  if (endpoint.agent.outputMode !== "verbose") {
    return undefined;
  }

  return async (event) => {
    const content = formatAgentProgress(event, { redactions: [endpoint.token] });

    if (content) {
      await sendProgressMessage(message, content);
    }
  };
}

async function sendProgressMessage(message: Message, content: string): Promise<void> {
  const channel = message.channel as Message["channel"] & { send?: (payload: { content: string }) => Promise<unknown> };

  if (typeof channel.send !== "function") {
    throw new Error("Discord channel cannot receive progress messages.");
  }

  await channel.send({ content });
}

async function deliverDiscordResponse(home: string, endpoint: Endpoint, message: Message, result: AgentRunResult): Promise<void> {
  if (result.exitCode === 0 && !result.hasTextResponse) {
    await reactToEmptySuccess(home, endpoint, message, result);
    return;
  }

  await sendResponse(message, discordResponseText(result));
  appendActivityLog(home, endpointActivity(home, endpoint, "discord_response_delivered", { exitCode: result.exitCode }));
}

function restartRuntimeAfterDeliveredResponse(home: string): void {
  if (consumeDeferredRuntimeRestart(home)) {
    startDeferredRuntimeRestart(home);
  }
}

async function reactToEmptySuccess(home: string, endpoint: Endpoint, message: Message, result: AgentRunResult): Promise<void> {
  try {
    await message.react(EMPTY_SUCCESS_REACTION);
    appendActivityLog(
      home,
      endpointActivity(home, endpoint, "discord_completion_reacted", {
        exitCode: result.exitCode,
        reaction: EMPTY_SUCCESS_REACTION
      })
    );
  } catch (error) {
    appendActivityLog(
      home,
      endpointActivity(home, endpoint, "discord_completion_reaction_failed", {
        exitCode: result.exitCode,
        reaction: EMPTY_SUCCESS_REACTION,
        error: errorMessage(error)
      })
    );
    await sendResponse(message, EMPTY_SUCCESS_REACTION_FALLBACK);
    appendActivityLog(home, endpointActivity(home, endpoint, "discord_response_delivered", { exitCode: result.exitCode }));
  }
}

function discordResponseText(result: AgentRunResult): string {
  const response = result.response.trim();

  if (response.length > 0) {
    return response;
  }

  const stderr = result.stderr.trim();

  if (stderr.length > 0) {
    return stderr;
  }

  return `Codex failed with exit code ${result.exitCode}. Check aide logs for details.`;
}

async function startDiscordContextTools(
  home: string,
  endpoint: Endpoint,
  message: Message,
  request: ReturnType<typeof buildDiscordRequestContext>
): Promise<ManagedAgentToolServer | undefined> {
  try {
    return await startDiscordContextToolServer({
      home,
      request,
      channel: message.channel
    });
  } catch (error) {
    appendActivityLog(home, endpointActivity(home, endpoint, "discord_context_tools_failed", {
      source: request.source,
      error: errorMessage(error)
    }));
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
