import { describe, expect, it } from "vitest";
import { formatAgentProgress } from "../src/lib/agent-progress.js";

describe("agent progress formatting", () => {
  it("formats Codex tool events as one-line progress messages", () => {
    expect(formatAgentProgress({
      attempt: "resume",
      type: "item.started",
      payload: {
        type: "item.started",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "bun run test",
          status: "in_progress"
        }
      }
    })).toBe("Running terminal command: bun run test");

    expect(formatAgentProgress({
      attempt: "resume",
      type: "item.completed",
      payload: {
        type: "item.completed",
        item: {
          id: "item_2",
          type: "file_change",
          changes: [{ path: "/tmp/config.toml", kind: "update" }],
          status: "completed"
        }
      }
    })).toBe("File edit finished: /tmp/config.toml");

    expect(formatAgentProgress({
      attempt: "resume",
      type: "item.completed",
      payload: {
        type: "item.completed",
        item: {
          id: "ws_1",
          type: "web_search",
          query: "Hermes Agent display.tool_progress"
        }
      }
    })).toBe("Web search finished: Hermes Agent display.tool_progress");
  });

  it("redacts configured secrets from progress messages", () => {
    expect(formatAgentProgress({
      type: "item.started",
      payload: {
        type: "item.started",
        item: {
          type: "command_execution",
          command: "aide endpoint add --token secret-token"
        }
      }
    }, { redactions: ["secret-token"] })).toBe("Running terminal command: aide endpoint add --token [redacted]");
  });

  it("omits turn completion usage events", () => {
    expect(formatAgentProgress({
      type: "turn.completed",
      payload: {
        type: "turn.completed",
        usage: {
          input_tokens: 17_779_802,
          output_tokens: 52_714
        }
      }
    })).toBeUndefined();
  });
});
