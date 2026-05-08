import { describe, expect, it, vi } from "vitest";
import { DiscordContextError } from "../src/lib/discord-context.js";
import { runDiscordContextTool } from "../src/lib/discord-context-mcp.js";

describe("discord context MCP tools", () => {
  it("returns JSON text for successful tool calls", async () => {
    const reader = {
      getRecentMessages: vi.fn().mockResolvedValue([{ id: "message-1", content: "hello" }])
    };
    const logger = vi.fn();

    const result = await runDiscordContextTool(reader as never, "discord_get_recent_messages", {
      source: "channel:channel-1",
      limit: 10
    }, logger);

    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify([{ id: "message-1", content: "hello" }], null, 2) }]
    });
    expect(reader.getRecentMessages).toHaveBeenCalledWith({ source: "channel:channel-1", limit: 10 });
    expect(logger).toHaveBeenCalledWith({
      toolName: "discord_get_recent_messages",
      requestedSource: "channel:channel-1",
      resultCount: 1,
      durationMs: expect.any(Number),
      errorCode: undefined
    });
  });

  it("maps context errors into MCP tool errors", async () => {
    const reader = {
      getRecentMessages: vi.fn().mockRejectedValue(new DiscordContextError("permission_denied", "outside scope"))
    };
    const logger = vi.fn();

    const result = await runDiscordContextTool(reader as never, "discord_get_recent_messages", {
      source: "channel:other"
    }, logger);

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ code: "permission_denied", message: "outside scope" }, null, 2) }]
    });
    expect(logger).toHaveBeenCalledWith({
      toolName: "discord_get_recent_messages",
      requestedSource: "channel:other",
      resultCount: 0,
      durationMs: expect.any(Number),
      errorCode: "permission_denied"
    });
  });

  it("maps unknown tool names into unsupported_source errors", async () => {
    const result = await runDiscordContextTool({} as never, "missing_tool", {});

    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ code: "unsupported_source", message: "Unsupported Discord context tool: missing_tool" }, null, 2) }]
    });
  });
});
