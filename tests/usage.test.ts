import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodexAgentConfig, defaultEndpointTriggerConfig, ensureAideHome } from "../src/lib/config.js";
import { addCodexUsage, addEstimatedUsage, estimateTokens, readUsageEntries, summarizeUsage } from "../src/lib/usage.js";
import type { Endpoint } from "../src/lib/types.js";

const cleanupPaths: string[] = [];

describe("usage", () => {
  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("estimates and aggregates tokens by endpoint", () => {
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = makeEndpoint();

    expect(estimateTokens("abcdefgh")).toBe(2);
    addEstimatedUsage(home, endpoint, 7, 3, new Date("2026-05-06T00:00:00.000Z"));
    addEstimatedUsage(home, endpoint, 11, 4, new Date("2026-05-06T01:00:00.000Z"));

    expect(readUsageEntries(home)).toHaveLength(2);
    const summary = summarizeUsage(home, new Date("2026-05-06T02:00:00.000Z"));
    expect(summary.today).toBe(25);
    expect(summary.total).toBe(25);
    expect(summary.todayInputTokens).toBe(18);
    expect(summary.todayOutputTokens).toBe(7);
    expect(summary.byEndpoint).toEqual([{ endpoint: endpoint.id, tokens: 25, inputTokens: 18, outputTokens: 7 }]);
  });

  it("records Codex usage with raw details", () => {
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = makeEndpoint();

    addCodexUsage(
      home,
      endpoint,
      {
        inputTokens: 10,
        outputTokens: 3,
        totalTokens: 13,
        cachedInputTokens: 4,
        reasoningOutputTokens: 2,
        raw: { codex: { threadId: "thread_1" } }
      },
      new Date("2026-05-06T00:00:00.000Z")
    );

    expect(readUsageEntries(home)).toMatchObject([
      {
        createdAt: "2026-05-06T00:00:00.000Z",
        tokens: 13,
        inputTokens: 10,
        outputTokens: 3,
        cachedInputTokens: 4,
        reasoningOutputTokens: 2,
        source: "codex",
        raw: { codex: { threadId: "thread_1" } }
      }
    ]);
    expect(summarizeUsage(home, new Date("2026-05-06T02:00:00.000Z")).source).toBe("codex");
  });

  it("marks mixed summaries when estimated and Codex usage coexist", () => {
    const home = tempHome();
    ensureAideHome(home);
    const endpoint = makeEndpoint();

    addEstimatedUsage(home, endpoint, 10, 5, new Date("2026-05-06T00:00:00.000Z"));
    addCodexUsage(home, endpoint, { inputTokens: 20, outputTokens: 7, totalTokens: 27 }, new Date("2026-05-06T01:00:00.000Z"));

    expect(summarizeUsage(home, new Date("2026-05-06T02:00:00.000Z")).source).toBe("mixed");
  });
});

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-usage-"));
  cleanupPaths.push(target);
  return target;
}

function makeEndpoint(): Endpoint {
  return {
    id: "discord-agent-ops",
    provider: "discord",
    enabled: true,
    token: "test-token",
    trigger: defaultEndpointTriggerConfig(),
    agent: defaultCodexAgentConfig()
  };
}
