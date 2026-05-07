import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message
} from "discord.js";
import { handleAssistantRequest } from "./assistant.js";
import { appendActivityLog, endpointActivity } from "./logging.js";
import type { Endpoint } from "./types.js";

export async function startDiscordEndpoint(home: string, endpoint: Endpoint): Promise<Client> {
  const token = endpoint.token;

  if (!token) {
    throw new Error(
      `Discord token is missing for endpoint ${endpoint.id}. Run \`aide config set endpoints.${endpoint.id}.token <discord-bot-token>\`.`
    );
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages
    ],
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

  if (!message.mentions.users.has(botUserId)) {
    return;
  }

  const content = stripMention(message.content, botUserId).trim();

  if (content.length === 0) {
    return;
  }

  appendActivityLog(home, endpointActivity(home, endpoint, "discord_message_received", { author: message.author.username }));

  if ("sendTyping" in message.channel && typeof message.channel.sendTyping === "function") {
    await message.channel.sendTyping();
  }

  const result = await handleAssistantRequest(home, endpoint, content, message.author.username, {
    source: discordMessageSource(message)
  });

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

function stripMention(content: string, botUserId: string): string {
  return content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
}

async function sendResponse(message: Message, response: string): Promise<void> {
  const chunks = chunkDiscordMessage(response);

  for (const chunk of chunks) {
    await message.reply({ content: chunk });
  }
}

export function chunkDiscordMessage(response: string): string[] {
  const max = 1900;

  if (response.length <= max) {
    return [response];
  }

  const chunks: string[] = [];

  for (let index = 0; index < response.length; index += max) {
    chunks.push(response.slice(index, index + max));
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
