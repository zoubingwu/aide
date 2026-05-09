import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message
} from "discord.js";
import { handleAssistantRequest } from "./assistant.js";
import { buildDiscordPromptMetadata, buildDiscordRequestContext } from "./discord-context.js";
import { startDiscordContextToolServer } from "./discord-context-mcp.js";
import { appendActivityLog, endpointActivity } from "./logging.js";
import type { ManagedAgentToolServer } from "./agent-tools.js";
import type { AgentRunResult, Endpoint } from "./types.js";

const DISCORD_TYPING_REFRESH_MS = 8_000;
const DISCORD_MESSAGE_CONTENT_LIMIT = 2_000;
const DISCORD_MESSAGE_CHUNK_BUFFER = 100;
const DISCORD_MESSAGE_CHUNK_SIZE = DISCORD_MESSAGE_CONTENT_LIMIT - DISCORD_MESSAGE_CHUNK_BUFFER;
const EMPTY_SUCCESS_REACTION = "✅";
const EMPTY_SUCCESS_REACTION_FALLBACK = "Done.";
const MARKDOWN_FENCE_INFO_REOPEN_LIMIT = 80;

interface MarkdownFenceState {
  marker: string;
  info: string;
}

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

export async function startDiscordEndpoint(home: string, endpoint: Endpoint): Promise<Client> {
  const token = endpoint.token;

  if (!token) {
    throw new Error(
      `Discord token is missing for endpoint ${endpoint.id}. Run \`aide config set endpoints.${endpoint.id}.token <discord-bot-token>\`.`
    );
  }

  const client = new Client({
    intents: discordGatewayIntents(endpoint),
    partials: [Partials.Channel]
  });

  client.on(Events.MessageCreate, async (message) => {
    await handleDiscordMessage(home, endpoint, message);
  });

  await waitForReady(client, token);
  appendActivityLog(home, endpointActivity(home, endpoint, "discord_connected"));
  return client;
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

  const result = await (async () => {
    try {
      return await withDiscordTyping(message.channel, () =>
        handleAssistantRequest(home, endpoint, content, message.author.username, {
          source: discordContext.source,
          metadata: buildDiscordPromptMetadata(discordContext),
          toolServers: toolServer ? [{ name: toolServer.name, url: toolServer.url }] : undefined
        })
      );
    } finally {
      await toolServer?.stop();
    }
  })();

  if (result.exitCode !== 0) {
    appendActivityLog(home, endpointActivity(home, endpoint, "agent_response_failed", { exitCode: result.exitCode }));
  }

  try {
    await deliverDiscordResponse(home, endpoint, message, result);
  } catch (error) {
    appendActivityLog(
      home,
      endpointActivity(home, endpoint, "discord_delivery_failed", {
        exitCode: result.exitCode,
        error: errorMessage(error)
      })
    );
    throw error;
  }
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

async function deliverDiscordResponse(home: string, endpoint: Endpoint, message: Message, result: AgentRunResult): Promise<void> {
  if (result.exitCode === 0 && !result.hasTextResponse) {
    await reactToEmptySuccess(home, endpoint, message, result);
    return;
  }

  await sendResponse(message, discordResponseText(result));
  appendActivityLog(home, endpointActivity(home, endpoint, "discord_response_delivered", { exitCode: result.exitCode }));
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

export function chunkDiscordMessage(response: string): string[] {
  if (response.length <= DISCORD_MESSAGE_CONTENT_LIMIT) {
    return [response];
  }

  const chunks: string[] = [];
  let fenceState: MarkdownFenceState | undefined;
  let index = 0;

  while (index < response.length) {
    const prefix = fenceState ? openMarkdownFence(fenceState) : "";
    let bodyLimit = Math.max(1, DISCORD_MESSAGE_CHUNK_SIZE - prefix.length);
    let chunk = "";
    let nextIndex = index;
    let nextFenceState: MarkdownFenceState | undefined;

    while (chunk.length === 0 || (chunk.length > DISCORD_MESSAGE_CONTENT_LIMIT && bodyLimit > 1)) {
      nextIndex = findDiscordChunkEnd(response, index, bodyLimit);

      const body = response.slice(index, nextIndex);
      nextFenceState = scanMarkdownFenceState(body, fenceState);
      chunk = `${prefix}${body}${nextFenceState ? closeMarkdownFence(body, nextFenceState) : ""}`;

      if (chunk.length > DISCORD_MESSAGE_CONTENT_LIMIT) {
        bodyLimit = Math.max(1, bodyLimit - (chunk.length - DISCORD_MESSAGE_CONTENT_LIMIT));
      }
    }

    chunks.push(chunk);
    index = nextIndex;
    fenceState = nextFenceState;
  }

  return chunks;
}

function findDiscordChunkEnd(response: string, start: number, limit: number): number {
  const hardEnd = Math.min(response.length, start + limit);

  if (hardEnd >= response.length) {
    return response.length;
  }

  const minimumEnd = start + Math.max(1, Math.floor(limit * 0.6));

  return findLastBreak(response, "\n\n", start, minimumEnd, hardEnd)
    ?? findLastBreak(response, "\n", start, minimumEnd, hardEnd)
    ?? findLastBreak(response, " ", start, minimumEnd, hardEnd)
    ?? hardEnd;
}

function findLastBreak(response: string, token: string, start: number, minimumEnd: number, hardEnd: number): number | undefined {
  const index = response.lastIndexOf(token, hardEnd - token.length);
  const end = index + token.length;

  if (index < start || end < minimumEnd || end <= start) {
    return undefined;
  }

  return end;
}

function scanMarkdownFenceState(text: string, initialState: MarkdownFenceState | undefined): MarkdownFenceState | undefined {
  let state = initialState;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    state = nextMarkdownFenceState(line, state);
  }

  return state;
}

function nextMarkdownFenceState(line: string, state: MarkdownFenceState | undefined): MarkdownFenceState | undefined {
  if (state) {
    return isClosingMarkdownFence(line, state) ? undefined : state;
  }

  return parseOpeningMarkdownFence(line);
}

function parseOpeningMarkdownFence(line: string): MarkdownFenceState | undefined {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);

  if (!match) {
    return undefined;
  }

  const marker = match[1] ?? "";
  const info = (match[2] ?? "").trimEnd();

  if (marker.length === 0) {
    return undefined;
  }

  if (marker.startsWith("`") && info.includes("`")) {
    return undefined;
  }

  return { marker, info: reopenMarkdownFenceInfo(info) };
}

function isClosingMarkdownFence(line: string, state: MarkdownFenceState): boolean {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
  const marker = match?.[1];

  return Boolean(marker && marker.startsWith(state.marker.slice(0, 1)) && marker.length >= state.marker.length);
}

function openMarkdownFence(state: MarkdownFenceState): string {
  return `${state.marker}${state.info}\n`;
}

function closeMarkdownFence(body: string, state: MarkdownFenceState): string {
  return `${body.endsWith("\n") ? "" : "\n"}${state.marker}`;
}

function reopenMarkdownFenceInfo(info: string): string {
  return info.length <= MARKDOWN_FENCE_INFO_REOPEN_LIMIT ? info : "";
}

export function discordMessageSource(message: { author: { id: string }; channelId: string; guildId: string | null }): string {
  return message.guildId ? `channel:${message.channelId}` : `user:${message.author.id}`;
}

function waitForReady(client: Client, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Discord startup timed out."));
    }, 30_000);

    client.once(Events.ClientReady, () => {
      clearTimeout(timeout);
      resolve();
    });

    client.once(Events.Error, (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    client.login(token).catch((error: unknown) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
