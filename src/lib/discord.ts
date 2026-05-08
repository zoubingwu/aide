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
import type { Endpoint } from "./types.js";

const DISCORD_TYPING_REFRESH_MS = 8_000;
const DISCORD_MESSAGE_CONTENT_LIMIT = 2_000;
const DISCORD_MESSAGE_CHUNK_BUFFER = 100;
const DISCORD_MESSAGE_CHUNK_SIZE = DISCORD_MESSAGE_CONTENT_LIMIT - DISCORD_MESSAGE_CHUNK_BUFFER;

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
    await sendResponse(message, result.response);
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

  appendActivityLog(home, endpointActivity(home, endpoint, "discord_response_delivered", { exitCode: result.exitCode }));
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
  if (response.length <= DISCORD_MESSAGE_CHUNK_SIZE) {
    return [response];
  }

  const chunks: string[] = [];

  for (let index = 0; index < response.length; index += DISCORD_MESSAGE_CHUNK_SIZE) {
    chunks.push(response.slice(index, index + DISCORD_MESSAGE_CHUNK_SIZE));
  }

  return chunks;
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
