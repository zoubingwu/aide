import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client, Message } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCodexAgentConfig } from "../src/lib/config.js";
import { handleAssistantRequest } from "../src/lib/assistant.js";
import { chunkDiscordMessage, discordMessageSource, handleDiscordMessage } from "../src/lib/discord.js";
import { deliverDiscordMessage, parseDiscordTarget } from "../src/lib/discord-delivery.js";
import { ACTIVITY_LOG_FILE } from "../src/lib/logging.js";
import { logsDir } from "../src/lib/paths.js";
import type { AgentRunResult, Endpoint } from "../src/lib/types.js";

vi.mock("../src/lib/assistant.js", () => ({
  handleAssistantRequest: vi.fn()
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

  it("replies once per long response chunk", async () => {
    const home = tempHome();
    const message = fakeMessage();
    mockHandleAssistantRequest().mockResolvedValueOnce({
      response: "x".repeat(4_001),
      stdout: "",
      stderr: "",
      exitCode: 0,
      resumed: true
    });

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
    mockHandleAssistantRequest().mockResolvedValueOnce({
      response: "agent failed",
      stdout: "",
      stderr: "failed",
      exitCode: 1,
      resumed: true
    });

    await handleDiscordMessage(home, endpoint, message);

    expect(message.reply).toHaveBeenCalledWith({ content: "agent failed" });
    expect(readActivityEvents(home).map((event) => [event.event, event.metadata?.exitCode])).toEqual([
      ["discord_message_received", undefined],
      ["agent_response_failed", 1],
      ["discord_response_delivered", 1]
    ]);
  });

  it("logs Discord delivery failures when replies fail", async () => {
    const home = tempHome();
    const message = fakeMessage({
      reply: vi.fn().mockRejectedValue(new Error("missing access"))
    });
    mockHandleAssistantRequest().mockResolvedValueOnce({
      response: "hello",
      stdout: "",
      stderr: "",
      exitCode: 0,
      resumed: true
    });

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

    resolveAgent!({
      response: "done",
      stdout: "",
      stderr: "",
      exitCode: 0,
      resumed: true
    });
    await handled;

    await vi.advanceTimersByTimeAsync(8_000);
    expect(sendTyping).toHaveBeenCalledTimes(3);
    expect(message.reply).toHaveBeenCalledWith({ content: "done" });
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

type FakeMessage = Message & {
  channel: Message["channel"] & { sendTyping: ReturnType<typeof vi.fn> };
  reply: ReturnType<typeof vi.fn>;
};

function fakeMessage(options: { reply?: ReturnType<typeof vi.fn> } = {}): FakeMessage {
  return {
    author: {
      bot: false,
      id: "user-1",
      username: "alice"
    },
    channel: {
      sendTyping: vi.fn()
    },
    channelId: "channel-1",
    client: {
      user: {
        id: "bot-1"
      }
    },
    content: "<@bot-1> hello",
    guildId: "guild-1",
    mentions: {
      users: {
        has: vi.fn((id: string) => id === "bot-1")
      }
    },
    reply: options.reply ?? vi.fn().mockResolvedValue(undefined)
  } as unknown as FakeMessage;
}

function readActivityEvents(home: string): Array<{ event: string; metadata?: Record<string, unknown> }> {
  const content = fs.readFileSync(path.join(logsDir(home), ACTIVITY_LOG_FILE), "utf8");
  return content.trim().split(/\r?\n/).map((line) => JSON.parse(line));
}
