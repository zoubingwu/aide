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
});
