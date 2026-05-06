import { describe, expect, it } from "vitest";
import { discordMessageSource } from "../src/lib/discord.js";
import { parseDiscordTarget } from "../src/lib/discord-delivery.js";

describe("discord delivery", () => {
  it("parses channel targets", () => {
    expect(parseDiscordTarget("channel:123")).toEqual({ kind: "channel", id: "123" });
  });

  it("parses user targets", () => {
    expect(parseDiscordTarget("user:987")).toEqual({ kind: "user", id: "987" });
  });

  it("rejects unsupported targets", () => {
    expect(() => parseDiscordTarget("thread:456")).toThrow("Unsupported Discord target: thread:456");
  });

  it("uses channel targets for guild messages", () => {
    expect(discordMessageSource(messageSource({ channelId: "123", guildId: "guild-1", authorId: "987" }))).toBe("channel:123");
  });

  it("uses user targets for direct messages", () => {
    expect(discordMessageSource(messageSource({ channelId: "dm-123", guildId: null, authorId: "987" }))).toBe("user:987");
  });
});

function messageSource(input: { channelId: string; guildId: string | null; authorId: string }) {
  return {
    channelId: input.channelId,
    guildId: input.guildId,
    author: { id: input.authorId }
  };
}
