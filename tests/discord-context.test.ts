import { describe, expect, it, vi } from "vitest";
import { defaultCodexAgentConfig } from "../src/lib/config.js";
import {
  buildDiscordPromptMetadata,
  buildDiscordRequestContext,
  clampDiscordLimit,
  DiscordContextReader,
  normalizeDiscordMessage
} from "../src/lib/discord-context.js";
import type { Endpoint } from "../src/lib/types.js";

const endpoint: Endpoint = {
  id: "discord-main",
  provider: "discord",
  enabled: true,
  token: "test-token",
  agent: defaultCodexAgentConfig()
};

describe("discord context", () => {
  it("builds request context for thread replies", () => {
    const context = buildDiscordRequestContext(endpoint, fakeMessage({
      id: "message-1",
      channelId: "thread-1",
      guildId: "guild-1",
      authorId: "user-1",
      channel: { id: "thread-1", parentId: "parent-1", isThread: () => true },
      reference: { messageId: "message-0" }
    }));

    expect(context).toEqual({
      endpointId: "discord-main",
      source: "channel:thread-1",
      messageId: "message-1",
      authorId: "user-1",
      guildId: "guild-1",
      channelId: "parent-1",
      threadId: "thread-1",
      replyToMessageId: "message-0"
    });
  });

  it("builds ordered prompt metadata from request context", () => {
    const metadata = buildDiscordPromptMetadata({
      endpointId: "discord-main",
      source: "channel:thread-1",
      messageId: "message-1",
      authorId: "user-1",
      guildId: "guild-1",
      channelId: "parent-1",
      threadId: "thread-1",
      replyToMessageId: "message-0"
    });

    expect(metadata).toEqual([
      { label: "Discord Message ID", value: "message-1" },
      { label: "Discord Guild ID", value: "guild-1" },
      { label: "Discord Channel ID", value: "parent-1" },
      { label: "Discord Thread ID", value: "thread-1" },
      { label: "Discord Reply To", value: "message-0" }
    ]);
  });

  it("normalizes Discord messages into compact records", () => {
    expect(normalizeDiscordMessage(fakeDiscordMessage({
      id: "message-1",
      authorId: "user-1",
      authorName: "alice",
      bot: false,
      createdTimestamp: Date.parse("2026-05-07T10:00:00.000Z"),
      content: "hello",
      channelId: "channel-1",
      attachments: [{ id: "file-1", name: "notes.txt", url: "https://cdn.example/notes.txt", contentType: "text/plain" }]
    }))).toEqual({
      id: "message-1",
      authorId: "user-1",
      authorName: "alice",
      authorKind: "user",
      timestamp: "2026-05-07T10:00:00.000Z",
      content: "hello",
      channelId: "channel-1",
      attachments: [{ id: "file-1", name: "notes.txt", url: "https://cdn.example/notes.txt", contentType: "text/plain" }]
    });
  });

  it("clamps requested limits", () => {
    expect(clampDiscordLimit(undefined, 20, 100)).toBe(20);
    expect(clampDiscordLimit(0, 20, 100)).toBe(20);
    expect(clampDiscordLimit(150, 20, 100)).toBe(100);
    expect(clampDiscordLimit(42, 20, 100)).toBe(42);
  });

  it("reads recent messages from the current source oldest to newest", async () => {
    const fetch = vi.fn().mockResolvedValue(messageMap([
      fakeDiscordMessage({ id: "message-2", authorId: "user-2", authorName: "bob", bot: false, createdTimestamp: 2, content: "second", channelId: "channel-1" }),
      fakeDiscordMessage({ id: "message-1", authorId: "user-1", authorName: "alice", bot: false, createdTimestamp: 1, content: "first", channelId: "channel-1" })
    ]));
    const reader = new DiscordContextReader({
      request: {
        endpointId: "discord-main",
        source: "channel:channel-1",
        messageId: "message-3",
        authorId: "user-1",
        guildId: "guild-1",
        channelId: "channel-1"
      },
      channel: { id: "channel-1", messages: { fetch } } as never
    });

    const records = await reader.getRecentMessages({ source: "channel:channel-1", limit: 50 });

    expect(fetch).toHaveBeenCalledWith({ limit: 50, before: undefined });
    expect(records.map((record) => record.id)).toEqual(["message-1", "message-2"]);
  });

  it("returns the referenced message when reply metadata exists", async () => {
    const referenced = fakeDiscordMessage({
      id: "message-0",
      authorId: "user-2",
      authorName: "bob",
      bot: false,
      createdTimestamp: 1,
      content: "referenced",
      channelId: "channel-1"
    });
    const fetch = vi.fn().mockResolvedValue(referenced);
    const reader = new DiscordContextReader({
      request: {
        endpointId: "discord-main",
        source: "channel:channel-1",
        messageId: "message-1",
        authorId: "user-1",
        guildId: "guild-1",
        channelId: "channel-1",
        replyToMessageId: "message-0"
      },
      channel: { id: "channel-1", messages: { fetch } } as never
    });

    const record = await reader.getReferencedMessage({ source: "channel:channel-1" });

    expect(fetch).toHaveBeenCalledWith("message-0");
    expect(record?.id).toBe("message-0");
  });

  it("enforces source scope", async () => {
    const reader = new DiscordContextReader({
      request: {
        endpointId: "discord-main",
        source: "channel:channel-1",
        messageId: "message-1",
        authorId: "user-1",
        guildId: "guild-1",
        channelId: "channel-1"
      },
      channel: { id: "channel-1", messages: { fetch: vi.fn() } } as never
    });

    await expect(reader.getRecentMessages({ source: "channel:other", limit: 10 })).rejects.toMatchObject({
      code: "permission_denied"
    });
  });

  it("searches recent messages by query and lookback", async () => {
    const fetch = vi.fn().mockResolvedValue(messageMap([
      fakeDiscordMessage({ id: "message-2", authorId: "user-2", authorName: "bob", bot: false, createdTimestamp: Date.parse("2026-05-07T10:00:00.000Z"), content: "ship release", channelId: "channel-1" }),
      fakeDiscordMessage({ id: "message-1", authorId: "user-1", authorName: "alice", bot: false, createdTimestamp: Date.parse("2026-05-07T09:00:00.000Z"), content: "other", channelId: "channel-1" })
    ]));
    const reader = new DiscordContextReader({
      request: {
        endpointId: "discord-main",
        source: "channel:channel-1",
        messageId: "message-3",
        authorId: "user-1",
        guildId: "guild-1",
        channelId: "channel-1"
      },
      channel: { id: "channel-1", messages: { fetch } } as never,
      now: () => new Date("2026-05-07T10:30:00.000Z")
    });

    const records = await reader.searchRecentMessages({ source: "channel:channel-1", query: "release", limit: 20, lookback: "24h" });

    expect(records.map((record) => record.id)).toEqual(["message-2"]);
  });
});

function fakeMessage(input: Record<string, unknown>) {
  return {
    id: input.id,
    channelId: input.channelId,
    guildId: input.guildId,
    author: { id: input.authorId },
    channel: input.channel,
    reference: input.reference
  } as never;
}

function fakeDiscordMessage(input: {
  id: string;
  authorId: string;
  authorName: string;
  bot: boolean;
  createdTimestamp: number;
  content: string;
  channelId: string;
  attachments?: Array<{ id: string; name: string; url: string; contentType?: string }>;
}) {
  return {
    id: input.id,
    author: { id: input.authorId, username: input.authorName, bot: input.bot },
    system: false,
    createdTimestamp: input.createdTimestamp,
    content: input.content,
    channelId: input.channelId,
    attachments: new Map((input.attachments ?? []).map((attachment) => [attachment.id, attachment])),
    reference: null
  } as never;
}

function messageMap(messages: unknown[]) {
  return new Map(messages.map((message) => [(message as { id: string }).id, message]));
}
