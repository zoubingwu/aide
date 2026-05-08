import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverImportCandidates,
  importPlanEntryEndpoint,
  planEndpointImports
} from "../src/lib/import-sources.js";
import { defaultCodexAgentConfig, defaultEndpointTriggerConfig } from "../src/lib/config.js";
import type { Endpoint } from "../src/lib/types.js";

const cleanupPaths: string[] = [];

describe("import sources", () => {
  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("discovers Hermes default and profile Discord tokens", () => {
    const hermesHome = tempDir("aide-hermes-");
    writeFile(path.join(hermesHome, ".env"), "DISCORD_BOT_TOKEN=default-token\nDISCORD_REQUIRE_MENTION=false\n");
    writeFile(
      path.join(hermesHome, "config.yaml"),
      [
        "gateway:",
        "  platforms:",
        "    discord:",
        "      free_response_channels:",
        "        - channel:123",
        ""
      ].join("\n")
    );
    writeFile(path.join(hermesHome, "profiles", "coder", ".env"), "CODER_DISCORD_TOKEN=profile-token\n");
    writeFile(
      path.join(hermesHome, "profiles", "coder", "config.yaml"),
      [
        "gateway:",
        "  platforms:",
        "    discord:",
        "      token: ${CODER_DISCORD_TOKEN}",
        ""
      ].join("\n")
    );

    const candidates = discoverImportCandidates("hermes", { hermesHome, env: {} });

    expect(candidates.map((candidate) => candidate.endpointId)).toEqual(["hermes", "hermes-coder"]);
    expect(candidates.map((candidate) => candidate.token)).toEqual(["default-token", "profile-token"]);
    expect(candidates[0]?.trigger).toEqual({
      requireMention: false,
      freeResponseSources: ["channel:123"]
    });
  });

  it("discovers OpenClaw default and account Discord tokens", () => {
    const openclawHome = tempDir("aide-openclaw-");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  env: { DISCORD_DEFAULT_TOKEN: 'default-token' },",
        "  channels: {",
        "    discord: {",
        "      token: { source: 'env', provider: 'default', id: 'DISCORD_DEFAULT_TOKEN' },",
        "      accounts: {",
        "        work: { token: 'work-token' },",
        "        duplicate: { token: 'work-token' },",
        "        disabled: { enabled: false, token: 'disabled-token' },",
        "      },",
        "    },",
        "  },",
        "}",
        ""
      ].join("\n")
    );

    const candidates = discoverImportCandidates("openclaw", { openclawHome, env: {}, cwd: openclawHome });

    expect(candidates.map((candidate) => [candidate.sourceName, candidate.endpointId, candidate.token])).toEqual([
      ["default", "openclaw", "default-token"],
      ["work", "openclaw-work", "work-token"],
      ["duplicate", "openclaw-duplicate", "work-token"]
    ]);
  });

  it("deduplicates by token and allocates endpoint ids around conflicts", () => {
    const existing = [endpoint("openclaw-work", "existing-token"), endpoint("already", "default-token")];
    const candidates = [
      candidate("openclaw", "default", "openclaw", "default-token"),
      candidate("openclaw", "work", "openclaw-work", "work-token"),
      candidate("openclaw", "duplicate", "openclaw-duplicate", "work-token")
    ];

    const plan = planEndpointImports(existing, candidates);

    expect(plan.map((entry) => [entry.endpointId, entry.action, entry.reason])).toEqual([
      ["already", "skip", "already imported as already"],
      ["openclaw-work-2", "create", undefined],
      ["openclaw-work-2", "skip", "same token as openclaw-work-2"]
    ]);
    expect(importPlanEntryEndpoint(plan[1]!).id).toBe("openclaw-work-2");
  });
});

function endpoint(id: string, token: string): Endpoint {
  return {
    id,
    provider: "discord",
    enabled: true,
    token,
    trigger: defaultEndpointTriggerConfig(),
    agent: defaultCodexAgentConfig()
  };
}

function candidate(
  source: "hermes" | "openclaw",
  sourceName: string,
  endpointId: string,
  token: string
) {
  return {
    source,
    sourceName,
    sourcePath: "/tmp/source",
    endpointId,
    token,
    trigger: defaultEndpointTriggerConfig()
  };
}

function tempDir(prefix: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(target);
  return target;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
