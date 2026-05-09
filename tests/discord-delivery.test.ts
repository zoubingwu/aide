import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GatewayIntentBits, type Client, type Message } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCodexAgentConfig, defaultEndpointTriggerConfig } from "../src/lib/config.js";
import { handleAssistantRequest } from "../src/lib/assistant.js";
import { chunkDiscordMessage, discordGatewayIntents, discordMessageSource, handleDiscordMessage } from "../src/lib/discord.js";
import { startDiscordContextToolServer } from "../src/lib/discord-context-mcp.js";
import { deliverDiscordMessage, parseDiscordTarget } from "../src/lib/discord-delivery.js";
import { ACTIVITY_LOG_FILE } from "../src/lib/logging.js";
import { logsDir } from "../src/lib/paths.js";
import type { AgentRunResult, Endpoint } from "../src/lib/types.js";

vi.mock("../src/lib/assistant.js", () => ({
  handleAssistantRequest: vi.fn()
}));

vi.mock("../src/lib/discord-context-mcp.js", () => ({
  startDiscordContextToolServer: vi.fn()
}));

const cleanupPaths: string[] = [];

describe("discord delivery", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();

    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

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

  it("splits long Discord messages below the API content limit", () => {
    const response = "x".repeat(4_001);
    const chunks = chunkDiscordMessage(response);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.join("")).toBe(response);
  });

  it("keeps split code fences balanced", () => {
    const lines = Array.from({ length: 260 }, (_, index) => `console.log("line ${index}");`);
    const response = ["Before", "", "```ts", ...lines, "```", "", "After"].join("\n");
    const chunks = chunkDiscordMessage(response);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.every(hasBalancedBacktickFences)).toBe(true);
    expect(chunks[0]).toContain("```ts\n");
    expect(chunks[0]).toMatch(/\n```$/);
    expect(chunks[1]).toMatch(/^```ts\n/);
  });

  it("escapes nested code fences inside markdown code blocks", () => {
    const response = [
      "**Body**",
      "",
      "```markdown",
      "Aide keeps the model simple:",
      "",
      "```text",
      "Discord / scheduled prompt -> Codex CLI -> response",
      "```",
      "",
      "Current features:",
      "",
      "- Discord endpoint backed by Codex CLI",
      "```"
    ].join("\n");
    const chunks = chunkDiscordMessage(response);
    const chunk = chunks[0] ?? "";

    expect(chunks).toHaveLength(1);
    expect(chunk).toContain("```markdown\n");
    expect(chunk).toContain("`\u200B``text\n");
    expect(chunk).toContain("`\u200B``\n\nCurrent features:");
    expect(chunk.trimEnd()).toMatch(/\n```$/);
    expect(hasBalancedBacktickFences(chunk)).toBe(true);
  });

  it("keeps shorter nested code fences inside longer markdown code blocks", () => {
    const response = [
      "````markdown",
      "```text",
      "example",
      "```",
      "````"
    ].join("\n");
    const chunks = chunkDiscordMessage(response);

    expect(chunks).toEqual([response]);
  });

  it("keeps split long code lines inside balanced fences", () => {
    const response = ["```js", "x".repeat(4_001), "```"].join("\n");
    const chunks = chunkDiscordMessage(response);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.every(hasBalancedBacktickFences)).toBe(true);
  });

  it("keeps long code fence info from causing tiny chunks", () => {
    const response = [`\`\`\`${"x".repeat(1_900)}`, "a".repeat(250), "```"].join("\n");
    const chunks = chunkDiscordMessage(response);

    expect(chunks.length).toBeLessThanOrEqual(3);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.every(hasBalancedBacktickFences)).toBe(true);
    expect(chunks.at(1)).toMatch(/^```\n/);
  });

  it("keeps overlong code fence markers within the Discord limit", () => {
    const fence = "`".repeat(1_000);
    const response = [fence, "a".repeat(2_500), fence].join("\n");
    const chunks = chunkDiscordMessage(response);

    expect(chunks.length).toBeLessThanOrEqual(3);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
  });

  it("keeps default mention-only endpoints off the privileged message content intent", () => {
    expect(discordGatewayIntents(endpoint)).not.toContain(GatewayIntentBits.MessageContent);
  });

  it("requests message content intent when the endpoint disables mention requirement", () => {
    const freeEndpoint: Endpoint = {
      ...endpoint,
      trigger: { requireMention: false, freeResponseSources: [] }
    };

    expect(discordGatewayIntents(freeEndpoint)).toContain(GatewayIntentBits.MessageContent);
  });

  it("requests message content intent for free-response sources", () => {
    const freeEndpoint: Endpoint = {
      ...endpoint,
      trigger: { requireMention: true, freeResponseSources: ["channel:channel-1"] }
    };

    expect(discordGatewayIntents(freeEndpoint)).toContain(GatewayIntentBits.MessageContent);
  });

  it("ignores guild messages without mentions by default", async () => {
    const home = tempHome();
    const message = fakeMessage({
      content: "hello",
      mentionsBot: false
    });

    await handleDiscordMessage(home, endpoint, message);

    expect(handleAssistantRequest).not.toHaveBeenCalled();
    expect(message.reply).not.toHaveBeenCalled();
  });

  it("responds to direct messages without mentions", async () => {
    const home = tempHome();
    const message = fakeMessage({
      content: "hello from dm",
      guildId: null,
      mentionsBot: false
    });
    mockHandleAssistantRequest().mockResolvedValueOnce(agentResult({ response: "done" }));

    await handleDiscordMessage(home, endpoint, message);

    expect(handleAssistantRequest).toHaveBeenCalledWith(home, endpoint, "hello from dm", "alice", expect.any(Object));
    expect(message.reply).toHaveBeenCalledWith({ content: "done" });
  });

  it("responds to free-response channel messages without mentions", async () => {
    const home = tempHome();
    const freeEndpoint: Endpoint = {
      ...endpoint,
      trigger: { requireMention: true, freeResponseSources: ["channel:channel-1"] }
    };
    const message = fakeMessage({
      content: "hello from channel",
      mentionsBot: false
    });
    mockHandleAssistantRequest().mockResolvedValueOnce(agentResult({ response: "done" }));

    await handleDiscordMessage(home, freeEndpoint, message);

    expect(handleAssistantRequest).toHaveBeenCalledWith(home, freeEndpoint, "hello from channel", "alice", expect.any(Object));
    expect(message.reply).toHaveBeenCalledWith({ content: "done" });
  });

  it("uses free-response parent channels for thread messages", async () => {
    const home = tempHome();
    const freeEndpoint: Endpoint = {
      ...endpoint,
      trigger: { requireMention: true, freeResponseSources: ["channel:parent-1"] }
    };
    const message = fakeMessage({
      channel: {
        id: "thread-1",
        parentId: "parent-1",
        isThread: () => true,
        sendTyping: vi.fn()
      } as FakeMessage["channel"] & { id: string; parentId: string; isThread: () => boolean },
      channelId: "thread-1",
      content: "hello from thread",
      mentionsBot: false
    });
    mockHandleAssistantRequest().mockResolvedValueOnce(agentResult({ response: "done" }));

    await handleDiscordMessage(home, freeEndpoint, message);

    expect(handleAssistantRequest).toHaveBeenCalledWith(home, freeEndpoint, "hello from thread", "alice", expect.any(Object));
    expect(message.reply).toHaveBeenCalledWith({ content: "done" });
  });

  it("responds to guild messages without mentions when mention requirement is disabled", async () => {
    const home = tempHome();
    const freeEndpoint: Endpoint = {
      ...endpoint,
      trigger: { requireMention: false, freeResponseSources: [] }
    };
    const message = fakeMessage({
      content: "hello from guild",
      mentionsBot: false
    });
    mockHandleAssistantRequest().mockResolvedValueOnce(agentResult({ response: "done" }));

    await handleDiscordMessage(home, freeEndpoint, message);

    expect(handleAssistantRequest).toHaveBeenCalledWith(home, freeEndpoint, "hello from guild", "alice", expect.any(Object));
    expect(message.reply).toHaveBeenCalledWith({ content: "done" });
  });

  it("replies once per long response chunk", async () => {
    const home = tempHome();
    const message = fakeMessage();
    mockHandleAssistantRequest().mockResolvedValueOnce(agentResult({ response: "x".repeat(4_001) }));

    await handleDiscordMessage(home, endpoint, message);

    expect(message.reply).toHaveBeenCalledTimes(3);
    expect(message.reply.mock.calls.every(([payload]) => payload.content.length <= 2_000)).toBe(true);
  });

  it("sends scheduled channel deliveries once per long response chunk", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValue({ send })
      }
    } as unknown as Client;

    await deliverDiscordMessage(client, "channel:123", "x".repeat(4_001));

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.every(([payload]) => payload.content.length <= 2_000)).toBe(true);
  });

  it("logs agent failures separately from Discord delivery", async () => {
    const home = tempHome();
    const message = fakeMessage();
    mockHandleAssistantRequest().mockResolvedValueOnce(agentResult({ response: "agent failed", stderr: "failed", exitCode: 1 }));

    await handleDiscordMessage(home, endpoint, message);

    expect(message.reply).toHaveBeenCalledWith({ content: "agent failed" });
    expect(readActivityEvents(home).map((event) => [event.event, event.metadata?.exitCode])).toEqual([
      ["discord_message_received", undefined],
      ["agent_response_failed", 1],
      ["discord_response_delivered", 1]
    ]);
  });

  it("reacts to successful agent runs with no text response", async () => {
    const home = tempHome();
    const message = fakeMessage();
    mockHandleAssistantRequest().mockResolvedValueOnce(agentResult({ response: "", hasTextResponse: false }));

    await handleDiscordMessage(home, endpoint, message);

    expect(message.react).toHaveBeenCalledWith("✅");
    expect(message.reply).not.toHaveBeenCalled();
    expect(readActivityEvents(home).map((event) => [event.event, event.metadata?.reaction])).toEqual([
      ["discord_message_received", undefined],
      ["discord_completion_reacted", "✅"]
    ]);
  });

  it("falls back to a short reply when the completion reaction fails", async () => {
    const home = tempHome();
    const message = fakeMessage({
      react: vi.fn().mockRejectedValue(new Error("missing reactions permission"))
    });
    mockHandleAssistantRequest().mockResolvedValueOnce(agentResult({ response: "", hasTextResponse: false }));

    await handleDiscordMessage(home, endpoint, message);

    expect(message.reply).toHaveBeenCalledWith({ content: "Done." });
    expect(readActivityEvents(home).map((event) => event.event)).toEqual([
      "discord_message_received",
      "discord_completion_reaction_failed",
      "discord_response_delivered"
    ]);
  });

  it("replies with an error reason when failed agent runs have no text response", async () => {
    const home = tempHome();
    const message = fakeMessage();
    mockHandleAssistantRequest().mockResolvedValueOnce(
      agentResult({ response: "", hasTextResponse: false, stderr: "model request failed", exitCode: 1 })
    );

    await handleDiscordMessage(home, endpoint, message);

    expect(message.react).not.toHaveBeenCalled();
    expect(message.reply).toHaveBeenCalledWith({ content: "model request failed" });
  });

  it("logs Discord delivery failures when replies fail", async () => {
    const home = tempHome();
    const message = fakeMessage({
      reply: vi.fn().mockRejectedValue(new Error("missing access"))
    });
    mockHandleAssistantRequest().mockResolvedValueOnce(agentResult({ response: "hello" }));

    await expect(handleDiscordMessage(home, endpoint, message)).rejects.toThrow("missing access");

    expect(readActivityEvents(home).at(-1)).toMatchObject({
      event: "discord_delivery_failed",
      metadata: {
        exitCode: 0,
        error: "missing access"
      }
    });
  });

  it("keeps Discord typing active while the agent is running", async () => {
    vi.useFakeTimers();

    const home = tempHome();
    const message = fakeMessage();
    const sendTyping = message.channel.sendTyping;
    let resolveAgent: (result: AgentRunResult) => void;

    vi.mocked(handleAssistantRequest).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAgent = resolve;
      })
    );

    const handled = handleDiscordMessage(home, endpoint, message);
    await vi.advanceTimersByTimeAsync(0);

    expect(sendTyping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(sendTyping).toHaveBeenCalledTimes(3);

    resolveAgent!(agentResult({ response: "done" }));
    await handled;

    await vi.advanceTimersByTimeAsync(8_000);
    expect(sendTyping).toHaveBeenCalledTimes(3);
    expect(message.reply).toHaveBeenCalledWith({ content: "done" });
  });

  it("passes Discord metadata and context tools to the assistant", async () => {
    const home = tempHome();
    const stop = vi.fn().mockResolvedValue(undefined);
    const message = fakeMessage({
      id: "message-1",
      reference: { messageId: "message-0" },
      channel: {
        id: "thread-1",
        parentId: "parent-1",
        isThread: () => true,
        sendTyping: vi.fn()
      } as FakeMessage["channel"] & { id: string; parentId: string; isThread: () => boolean },
      channelId: "thread-1"
    });
    mockStartDiscordContextToolServer().mockResolvedValueOnce({
      name: "aide-discord-context",
      url: "http://127.0.0.1:43210/mcp",
      stop
    });
    mockHandleAssistantRequest().mockResolvedValueOnce(agentResult({ response: "done" }));

    await handleDiscordMessage(home, endpoint, message);

    expect(handleAssistantRequest).toHaveBeenCalledWith(home, endpoint, "hello", "alice", {
      source: "channel:thread-1",
      metadata: [
        { label: "Discord Message ID", value: "message-1" },
        { label: "Aide Endpoint ID", value: "discord-agent-ops" },
        { label: "Discord Guild ID", value: "guild-1" },
        { label: "Discord Channel ID", value: "parent-1" },
        { label: "Discord Thread ID", value: "thread-1" },
        { label: "Discord Reply To", value: "message-0" }
      ],
      toolServers: [{ name: "aide-discord-context", url: "http://127.0.0.1:43210/mcp" }]
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops Discord context tools when typing fails before the agent runs", async () => {
    const home = tempHome();
    const stop = vi.fn().mockResolvedValue(undefined);
    const message = fakeMessage({
      channel: {
        id: "channel-1",
        sendTyping: vi.fn().mockRejectedValue(new Error("typing denied"))
      } as FakeMessage["channel"] & { id: string }
    });
    mockStartDiscordContextToolServer().mockResolvedValueOnce({
      name: "aide-discord-context",
      url: "http://127.0.0.1:43210/mcp",
      stop
    });

    await expect(handleDiscordMessage(home, endpoint, message)).rejects.toThrow("typing denied");

    expect(handleAssistantRequest).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

function messageSource(input: { channelId: string; guildId: string | null; authorId: string }) {
  return {
    channelId: input.channelId,
    guildId: input.guildId,
    author: { id: input.authorId }
  };
}

const endpoint: Endpoint = {
  id: "discord-agent-ops",
  provider: "discord",
  enabled: true,
  token: "test-token",
  trigger: defaultEndpointTriggerConfig(),
  agent: defaultCodexAgentConfig()
};

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-discord-"));
  cleanupPaths.push(target);
  return target;
}

function mockHandleAssistantRequest(): {
  mockResolvedValueOnce(value: unknown): ReturnType<typeof mockHandleAssistantRequest>;
} {
  return handleAssistantRequest as unknown as ReturnType<typeof mockHandleAssistantRequest>;
}

function mockStartDiscordContextToolServer(): {
  mockResolvedValueOnce(value: unknown): ReturnType<typeof mockStartDiscordContextToolServer>;
} {
  return startDiscordContextToolServer as unknown as ReturnType<typeof mockStartDiscordContextToolServer>;
}

function agentResult(overrides: Partial<AgentRunResult>): AgentRunResult {
  return {
    response: "done",
    hasTextResponse: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    resumed: true,
    ...overrides
  };
}

function hasBalancedBacktickFences(content: string): boolean {
  const fenceCount = content
    .split(/\r?\n/)
    .filter((line) => /^[ \t]*```/.test(line))
    .length;

  return fenceCount % 2 === 0;
}

type FakeMessage = Message & {
  channel: Message["channel"] & { sendTyping: ReturnType<typeof vi.fn> };
  reply: ReturnType<typeof vi.fn>;
  react: ReturnType<typeof vi.fn>;
};

function fakeMessage(options: {
  id?: string;
  reference?: { messageId: string };
  channel?: FakeMessage["channel"] & { id?: string; parentId?: string | null; isThread?: () => boolean };
  channelId?: string;
  content?: string;
  guildId?: string | null;
  mentionsBot?: boolean;
  reply?: ReturnType<typeof vi.fn>;
  react?: ReturnType<typeof vi.fn>;
} = {}): FakeMessage {
  const mentionsBot = options.mentionsBot ?? true;

  return {
    id: options.id ?? "message-1",
    author: {
      bot: false,
      id: "user-1",
      username: "alice"
    },
    channel: options.channel ?? {
      id: "channel-1",
      sendTyping: vi.fn()
    },
    channelId: options.channelId ?? "channel-1",
    client: {
      user: {
        id: "bot-1"
      }
    },
    content: options.content ?? "<@bot-1> hello",
    guildId: options.guildId === undefined ? "guild-1" : options.guildId,
    mentions: {
      users: {
        has: vi.fn((id: string) => mentionsBot && id === "bot-1")
      }
    },
    reference: options.reference ?? null,
    reply: options.reply ?? vi.fn().mockResolvedValue(undefined),
    react: options.react ?? vi.fn().mockResolvedValue(undefined)
  } as unknown as FakeMessage;
}

function readActivityEvents(home: string): Array<{ event: string; metadata?: Record<string, unknown> }> {
  const content = fs.readFileSync(path.join(logsDir(home), ACTIVITY_LOG_FILE), "utf8");
  return content.trim().split(/\r?\n/).map((line) => JSON.parse(line));
}
