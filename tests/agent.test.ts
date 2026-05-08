import { describe, expect, it } from "vitest";
import { agentProviderLabel, makeAssistantPrompt } from "../src/lib/agent.js";

describe("agent", () => {
  it("labels the default Codex provider", () => {
    expect(agentProviderLabel("codex")).toBe("Codex");
  });

  it("builds the shared assistant prompt with metadata and user message sections", () => {
    const prompt = makeAssistantPrompt("hello", "alice");

    expect(prompt).toBe(`# Metadata

Author: alice

# User Message

hello`);
  });

  it("includes the request source when provided", () => {
    const prompt = makeAssistantPrompt(
      "schedule this daily",
      "alice",
      { source: "channel:123" }
    );

    expect(prompt).toBe(`# Metadata

Author: alice
Source: channel:123

# User Message

schedule this daily`);
  });

  it("includes ordered request metadata when provided", () => {
    const prompt = makeAssistantPrompt("summarize this thread", "alice", {
      source: "channel:thread-1",
      metadata: [
        { label: "Discord Message ID", value: "message-1" },
        { label: "Discord Guild ID", value: "guild-1" },
        { label: "Discord Channel ID", value: "parent-1" },
        { label: "Discord Thread ID", value: "thread-1" },
        { label: "Discord Reply To", value: "message-0" },
        { label: "Ignored Empty", value: undefined }
      ]
    });

    expect(prompt).toBe(`# Metadata

Author: alice
Source: channel:thread-1
Discord Message ID: message-1
Discord Guild ID: guild-1
Discord Channel ID: parent-1
Discord Thread ID: thread-1
Discord Reply To: message-0

# User Message

summarize this thread`);
  });
});
