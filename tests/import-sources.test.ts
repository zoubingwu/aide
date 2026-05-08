import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverImportCandidates,
  importPlanEntryEndpoint,
  planEndpointImports,
  readyImportCandidates,
  resolveSecretImportCandidate,
  type ReadyImportCandidate
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

    const candidates = readyImportCandidates(discoverImportCandidates("hermes", { hermesHome, env: {} }));

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

    const candidates = readyImportCandidates(discoverImportCandidates("openclaw", { openclawHome, env: {}, cwd: openclawHome }));

    expect(candidates.map((candidate) => [candidate.sourceName, candidate.endpointId, candidate.token])).toEqual([
      ["default", "openclaw", "default-token"],
      ["work", "openclaw-work", "work-token"],
      ["duplicate", "openclaw-duplicate", "work-token"]
    ]);
  });

  it("uses OPENCLAW_HOME for OpenClaw config and env discovery", () => {
    const openclawHome = tempDir("aide-openclaw-home-");
    writeFile(path.join(openclawHome, ".env"), "DISCORD_BOT_TOKEN=home-token\n");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  channels: { discord: { token: '${DISCORD_BOT_TOKEN}' } },",
        "}",
        ""
      ].join("\n")
    );

    const candidates = readyImportCandidates(discoverImportCandidates("openclaw", {
      env: { OPENCLAW_HOME: openclawHome },
      cwd: tempDir("aide-openclaw-cwd-")
    }));

    expect(candidates.map((candidate) => [candidate.sourcePath, candidate.token])).toEqual([
      [path.join(openclawHome, "openclaw.json"), "home-token"]
    ]);
  });

  it("uses OPENCLAW_STATE_DIR for OpenClaw config and env discovery", () => {
    const openclawHome = tempDir("aide-openclaw-state-");
    writeFile(path.join(openclawHome, ".env"), "DISCORD_BOT_TOKEN=state-token\n");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  channels: { discord: { token: '${DISCORD_BOT_TOKEN}' } },",
        "}",
        ""
      ].join("\n")
    );

    const candidates = readyImportCandidates(discoverImportCandidates("openclaw", {
      env: { OPENCLAW_STATE_DIR: openclawHome },
      cwd: tempDir("aide-openclaw-cwd-")
    }));

    expect(candidates.map((candidate) => [candidate.sourcePath, candidate.token])).toEqual([
      [path.join(openclawHome, "openclaw.json"), "state-token"]
    ]);
  });

  it("skips OpenClaw account token templates that cannot be resolved", () => {
    const openclawHome = tempDir("aide-openclaw-missing-account-env-");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  channels: {",
        "    discord: {",
        "      accounts: { work: { token: '${DISCORD_WORK_TOKEN}' } },",
        "    },",
        "  },",
        "}",
        ""
      ].join("\n")
    );

    const candidates = readyImportCandidates(discoverImportCandidates("openclaw", {
      openclawHome,
      env: {},
      cwd: tempDir("aide-openclaw-cwd-")
    }));

    expect(candidates).toEqual([]);
  });

  it("treats OpenClaw config env as a fallback below dotenv files", () => {
    const openclawHome = tempDir("aide-openclaw-env-");
    writeFile(path.join(openclawHome, ".env"), "DISCORD_BOT_TOKEN=dotenv-token\n");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  env: { DISCORD_BOT_TOKEN: 'config-token' },",
        "  channels: { discord: { token: '${DISCORD_BOT_TOKEN}' } },",
        "}",
        ""
      ].join("\n")
    );

    const candidates = readyImportCandidates(discoverImportCandidates("openclaw", {
      openclawHome,
      env: {},
      cwd: tempDir("aide-openclaw-cwd-")
    }));

    expect(candidates.map((candidate) => candidate.token)).toEqual(["dotenv-token"]);
  });

  it("reads OpenClaw config env vars fallback values", () => {
    const openclawHome = tempDir("aide-openclaw-env-vars-");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  env: { vars: { DISCORD_BOT_TOKEN: 'vars-token' } },",
        "  channels: { discord: { token: '${DISCORD_BOT_TOKEN}' } },",
        "}",
        ""
      ].join("\n")
    );

    const candidates = readyImportCandidates(discoverImportCandidates("openclaw", {
      openclawHome,
      env: {},
      cwd: tempDir("aide-openclaw-cwd-")
    }));

    expect(candidates.map((candidate) => candidate.token)).toEqual(["vars-token"]);
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

  it("resolves OpenClaw file SecretRefs after confirmation", async () => {
    const openclawHome = tempDir("aide-openclaw-file-");
    const secretPath = path.join(openclawHome, "secrets.json");
    writeFile(secretPath, JSON.stringify({ discord: { token: "file-token" } }));
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  secrets: {",
        "    providers: {",
        `      localfile: { source: 'file', path: '${secretPath}', mode: 'json' },`,
        "    },",
        "  },",
        "  channels: {",
        "    discord: { token: { source: 'file', provider: 'localfile', id: '/discord/token' } },",
        "  },",
        "}",
        ""
      ].join("\n")
    );

    const [candidate] = discoverImportCandidates("openclaw", { openclawHome, env: {}, cwd: openclawHome });

    expect(candidate?.kind).toBe("secret");
    if (!candidate || candidate.kind !== "secret") {
      throw new Error("Expected OpenClaw file SecretRef candidate.");
    }
    const resolved = await resolveSecretImportCandidate(candidate);
    expect(resolved.token).toBe("file-token");
  });

  it("resolves OpenClaw exec SecretRefs after confirmation", async () => {
    const openclawHome = tempDir("aide-openclaw-exec-");
    const scriptPath = path.join(openclawHome, "resolve-secret.sh");
    writeFile(
      scriptPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "printf '{\"protocolVersion\":1,\"values\":{\"discord/token\":\"exec-token\"}}'",
        ""
      ].join("\n")
    );
    fs.chmodSync(scriptPath, 0o700);
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  secrets: {",
        "    providers: {",
        `      vault: { source: 'exec', command: '${scriptPath}', jsonOnly: true },`,
        "    },",
        "  },",
        "  channels: {",
        "    discord: { token: { source: 'exec', provider: 'vault', id: 'discord/token' } },",
        "  },",
        "}",
        ""
      ].join("\n")
    );

    const [candidate] = discoverImportCandidates("openclaw", { openclawHome, env: {}, cwd: openclawHome });

    expect(candidate?.kind).toBe("secret");
    if (!candidate || candidate.kind !== "secret") {
      throw new Error("Expected OpenClaw exec SecretRef candidate.");
    }
    const resolved = await resolveSecretImportCandidate(candidate);
    expect(resolved.token).toBe("exec-token");
  });

  it("isolates OpenClaw exec SecretRef environment to passEnv and provider env", async () => {
    const openclawHome = tempDir("aide-openclaw-exec-env-");
    const scriptPath = path.join(openclawHome, "resolve-secret-env.sh");
    writeFile(
      scriptPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        "if [ -n \"$DISCORD_BOT_TOKEN\" ]; then",
        "  printf '{\"protocolVersion\":1,\"values\":{\"discord/token\":\"leaked-token\"}}'",
        "else",
        "  printf '{\"protocolVersion\":1,\"values\":{\"discord/token\":\"isolated-token\"}}'",
        "fi",
        ""
      ].join("\n")
    );
    fs.chmodSync(scriptPath, 0o700);
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  secrets: {",
        "    providers: {",
        `      vault: { source: 'exec', command: '${scriptPath}', passEnv: [], jsonOnly: true },`,
        "    },",
        "  },",
        "  channels: {",
        "    discord: { token: { source: 'exec', provider: 'vault', id: 'discord/token' } },",
        "  },",
        "}",
        ""
      ].join("\n")
    );

    const [candidate] = discoverImportCandidates("openclaw", { openclawHome, env: {}, cwd: openclawHome });

    expect(candidate?.kind).toBe("secret");
    if (!candidate || candidate.kind !== "secret") {
      throw new Error("Expected OpenClaw exec SecretRef candidate.");
    }
    const resolved = await resolveSecretImportCandidate(candidate, {
      env: { DISCORD_BOT_TOKEN: "parent-token" }
    });
    expect(resolved.token).toBe("isolated-token");
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
): ReadyImportCandidate {
  return {
    kind: "ready",
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
