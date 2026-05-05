import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAideHome } from "../src/lib/config.js";
import { addEstimatedUsage, estimateTokens, readUsageEntries, summarizeUsage } from "../src/lib/usage.js";
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
    addEstimatedUsage(home, endpoint, 10, new Date("2026-05-06T00:00:00.000Z"));
    addEstimatedUsage(home, endpoint, 15, new Date("2026-05-06T01:00:00.000Z"));

    expect(readUsageEntries(home)).toHaveLength(2);
    const summary = summarizeUsage(home, new Date("2026-05-06T02:00:00.000Z"));
    expect(summary.today).toBe(25);
    expect(summary.total).toBe(25);
    expect(summary.byEndpoint).toEqual([{ endpoint: endpoint.id, tokens: 25 }]);
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
    name: "Discord #agent-ops",
    enabled: true,
    workspacePath: "/tmp/discord-agent-ops",
    routing: {
      mode: "mention_only",
      server: "agent-lab",
      channel: "#agent-ops"
    },
    permissions: {
      requireApprovalForShell: true,
      requireApprovalForWrites: true,
      restrictToEndpointWorkspace: true
    }
  };
}
