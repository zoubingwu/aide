import {
  Client,
  Events,
  Partials
} from "discord.js";
import { handleDiscordInteraction, registerDiscordCommands } from "./discord-commands.js";
import { discordGatewayIntents, handleDiscordMessage } from "./discord-messages.js";
import { appendActivityLog, endpointActivity } from "./logging.js";
import type { Endpoint } from "./types.js";

export async function startDiscordEndpoint(home: string, endpoint: Endpoint): Promise<Client> {
  const token = endpoint.token;

  if (!token) {
    throw new Error(
      `Discord token is missing for endpoint ${endpoint.id}. Edit the endpoint token in Aide config.toml, then run \`aide restart\`.`
    );
  }

  const client = new Client({
    intents: discordGatewayIntents(endpoint),
    partials: [Partials.Channel]
  });

  client.on(Events.MessageCreate, async (message) => {
    await handleDiscordMessage(home, endpoint, message);
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    await handleDiscordInteraction(home, endpoint, interaction);
  });

  await waitForReady(client, token);
  await registerDiscordCommands(home, endpoint, client);
  appendActivityLog(home, endpointActivity(home, endpoint, "discord_connected"));
  return client;
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
