import type { Client } from "discord.js";
import { chunkDiscordMessage } from "./discord.js";

export type DiscordTarget =
  | { kind: "channel"; id: string }
  | { kind: "user"; id: string };

export function parseDiscordTarget(target: string): DiscordTarget {
  const [kind, id] = target.split(":", 2);

  if ((kind === "channel" || kind === "user") && id) {
    return { kind, id };
  }

  throw new Error(`Unsupported Discord target: ${target}`);
}

export async function deliverDiscordMessage(client: Client, target: string, response: string): Promise<void> {
  const parsed = parseDiscordTarget(target);
  const chunks = chunkDiscordMessage(response);

  if (parsed.kind === "channel") {
    const channel = await client.channels.fetch(parsed.id);

    if (!channel || !("send" in channel) || typeof channel.send !== "function") {
      throw new Error(`Discord channel cannot receive messages: ${parsed.id}`);
    }

    for (const chunk of chunks) {
      await channel.send({ content: chunk });
    }
    return;
  }

  const user = await client.users.fetch(parsed.id);

  for (const chunk of chunks) {
    await user.send({ content: chunk });
  }
}
