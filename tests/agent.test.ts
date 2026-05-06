import { describe, expect, it } from "vitest";
import { agentProviderLabel, makeAssistantPrompt } from "../src/lib/agent.js";

describe("agent", () => {
  it("labels the default Codex provider", () => {
    expect(agentProviderLabel("codex")).toBe("Codex");
  });

  it("builds the shared assistant prompt without CLI-specific fields", () => {
    const prompt = makeAssistantPrompt(
      {
        id: "discord-agent-ops",
        provider: "discord",
        enabled: true
      },
      "hello",
      "alice"
    );

    expect(prompt).toContain("Endpoint: discord-agent-ops");
    expect(prompt).toContain("Provider: discord");
    expect(prompt).toContain("Author: alice");
    expect(prompt).toContain("Scheduling: Use aide schedule commands");
    expect(prompt).toContain("--kind once");
    expect(prompt).toContain("--run-at");
    expect(prompt).toContain("hello");
  });

  it("includes the request source when provided", () => {
    const prompt = makeAssistantPrompt(
      {
        id: "discord-agent-ops",
        provider: "discord",
        enabled: true
      },
      "schedule this daily",
      "alice",
      { source: "channel:123" }
    );

    expect(prompt).toContain("Source: channel:123");
    expect(prompt).toContain("schedule this daily");
  });
});
