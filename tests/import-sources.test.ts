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
        "        - '123'",
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

  it("normalizes Hermes env free-response channel ids", () => {
    const hermesHome = tempDir("aide-hermes-env-channels-");
    writeFile(
      path.join(hermesHome, ".env"),
      "DISCORD_BOT_TOKEN=default-token\nDISCORD_FREE_RESPONSE_CHANNELS=123,channel:456\n"
    );

    const candidates = readyImportCandidates(discoverImportCandidates("hermes", { hermesHome, env: {} }));

    expect(candidates[0]?.trigger.freeResponseSources).toEqual(["channel:123", "channel:456"]);
  });

  it("lets process env override Hermes profile dotenv values", () => {
    const hermesHome = tempDir("aide-hermes-env-override-");
    writeFile(path.join(hermesHome, ".env"), "DISCORD_BOT_TOKEN=stale-file-token\nDISCORD_REQUIRE_MENTION=true\n");

    const candidates = readyImportCandidates(discoverImportCandidates("hermes", {
      hermesHome,
      env: {
        DISCORD_BOT_TOKEN: "process-token",
        DISCORD_REQUIRE_MENTION: "false"
      }
    }));

    expect(candidates.map((candidate) => candidate.token)).toEqual(["process-token"]);
    expect(candidates[0]?.trigger.requireMention).toBe(false);
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

  it("uses OpenClaw default account tokens before env fallback", () => {
    const openclawHome = tempDir("aide-openclaw-default-account-");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  channels: {",
        "    discord: {",
        "      accounts: {",
        "        default: { token: 'account-token' },",
        "      },",
        "    },",
        "  },",
        "}",
        ""
      ].join("\n")
    );

    const candidates = readyImportCandidates(discoverImportCandidates("openclaw", {
      openclawHome,
      env: { DISCORD_BOT_TOKEN: "stale-env-token" },
      cwd: openclawHome
    }));

    expect(candidates.map((candidate) => [candidate.sourceName, candidate.endpointId, candidate.token])).toEqual([
      ["default", "openclaw", "account-token"]
    ]);
  });

  it("skips the OpenClaw default endpoint when the default account is disabled", () => {
    const openclawHome = tempDir("aide-openclaw-disabled-default-");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  channels: {",
        "    discord: {",
        "      token: 'top-level-token',",
        "      accounts: {",
        "        default: { enabled: false, token: 'disabled-token' },",
        "        work: { token: 'work-token' },",
        "      },",
        "    },",
        "  },",
        "}",
        ""
      ].join("\n")
    );

    const candidates = readyImportCandidates(discoverImportCandidates("openclaw", {
      openclawHome,
      env: { DISCORD_BOT_TOKEN: "stale-env-token" },
      cwd: openclawHome
    }));

    expect(candidates.map((candidate) => [candidate.sourceName, candidate.endpointId, candidate.token])).toEqual([
      ["work", "openclaw-work", "work-token"]
    ]);
  });

  it("resolves OpenClaw config includes before Discord token discovery", () => {
    const openclawHome = tempDir("aide-openclaw-include-");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  '$include': './discord.json5',",
        "}",
        ""
      ].join("\n")
    );
    writeFile(
      path.join(openclawHome, "discord.json5"),
      [
        "{",
        "  channels: { discord: { token: 'included-token' } },",
        "}",
        ""
      ].join("\n")
    );

    const candidates = readyImportCandidates(discoverImportCandidates("openclaw", {
      openclawHome,
      env: { DISCORD_BOT_TOKEN: "stale-env-token" },
      cwd: openclawHome
    }));

    expect(candidates.map((candidate) => [candidate.sourceName, candidate.endpointId, candidate.token])).toEqual([
      ["default", "openclaw", "included-token"]
    ]);
  });

  it("rejects OpenClaw config includes outside the config directory by default", () => {
    const root = tempDir("aide-openclaw-include-root-");
    const openclawHome = path.join(root, "home");
    const externalDir = path.join(root, "external");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  '$include': '../external/discord.json5',",
        "}",
        ""
      ].join("\n")
    );
    writeFile(
      path.join(externalDir, "discord.json5"),
      [
        "{",
        "  channels: { discord: { token: 'external-token' } },",
        "}",
        ""
      ].join("\n")
    );

    expect(() => discoverImportCandidates("openclaw", {
      openclawHome,
      env: {},
      cwd: openclawHome
    })).toThrow("OpenClaw config include outside allowed roots");
  });

  it("allows OpenClaw config includes from OPENCLAW_INCLUDE_ROOTS", () => {
    const root = tempDir("aide-openclaw-include-allowed-root-");
    const openclawHome = path.join(root, "home");
    const externalDir = path.join(root, "external");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  '$include': '../external/discord.json5',",
        "}",
        ""
      ].join("\n")
    );
    writeFile(
      path.join(externalDir, "discord.json5"),
      [
        "{",
        "  channels: { discord: { token: 'external-token' } },",
        "}",
        ""
      ].join("\n")
    );

    const candidates = readyImportCandidates(discoverImportCandidates("openclaw", {
      openclawHome,
      env: { OPENCLAW_INCLUDE_ROOTS: externalDir },
      cwd: openclawHome
    }));

    expect(candidates.map((candidate) => candidate.token)).toEqual(["external-token"]);
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

  it("fails missing explicit OpenClaw config paths without falling back", () => {
    const openclawHome = tempDir("aide-openclaw-explicit-missing-home-");
    const explicitHome = tempDir("aide-openclaw-explicit-missing-");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  channels: { discord: { token: 'fallback-token' } },",
        "}",
        ""
      ].join("\n")
    );

    expect(() => discoverImportCandidates("openclaw", {
      openclawHome,
      openclawConfigPath: path.join(explicitHome, "missing.json"),
      env: { DISCORD_BOT_TOKEN: "env-token" },
      cwd: tempDir("aide-openclaw-cwd-")
    })).toThrow("OpenClaw config not found");
  });

  it("reads dotenv files next to explicit OpenClaw config paths", () => {
    const openclawHome = tempDir("aide-openclaw-explicit-home-");
    const explicitHome = tempDir("aide-openclaw-explicit-");
    writeFile(path.join(openclawHome, ".env"), "DISCORD_BOT_TOKEN=home-token\n");
    writeFile(path.join(explicitHome, ".env"), "DISCORD_BOT_TOKEN=explicit-token\n");
    writeFile(
      path.join(explicitHome, "custom-openclaw.json"),
      [
        "{",
        "  channels: { discord: { token: '${DISCORD_BOT_TOKEN}' } },",
        "}",
        ""
      ].join("\n")
    );

    const candidates = readyImportCandidates(discoverImportCandidates("openclaw", {
      openclawHome,
      openclawConfigPath: path.join(explicitHome, "custom-openclaw.json"),
      env: {},
      cwd: tempDir("aide-openclaw-cwd-")
    }));

    expect(candidates.map((candidate) => [candidate.sourcePath, candidate.token])).toEqual([
      [path.join(explicitHome, "custom-openclaw.json"), "explicit-token"]
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

  it("treats OpenClaw string env templates as config substitution", () => {
    const openclawHome = tempDir("aide-openclaw-template-substitution-");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  env: { vars: { DISCORD_BOT_TOKEN: 'template-token' } },",
        "  secrets: { providers: { default: { source: 'env', allowlist: ['OTHER_TOKEN'] } } },",
        "  channels: {",
        "    discord: {",
        "      accounts: { default: { token: '${DISCORD_BOT_TOKEN}' } },",
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

    expect(candidates.map((candidate) => [candidate.sourceName, candidate.endpointId, candidate.token])).toEqual([
      ["default", "openclaw", "template-token"]
    ]);
  });

  it("resolves missing OpenClaw Discord token env values from shellEnv after confirmation", async () => {
    const openclawHome = tempDir("aide-openclaw-shell-env-");
    const cwd = tempDir("aide-openclaw-shell-env-cwd-");
    const shellPath = path.join(openclawHome, "shell-env.sh");
    const markerPath = path.join(openclawHome, "shell-env-ran");
    writeFile(
      shellPath,
      [
        "#!/bin/sh",
        `printf ran > '${markerPath}'`,
        "printf 'DISCORD_BOT_TOKEN=shell-token\\n'",
        ""
      ].join("\n")
    );
    fs.chmodSync(shellPath, 0o700);
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  channels: { discord: { token: '${DISCORD_BOT_TOKEN}' } },",
        "}",
        ""
      ].join("\n")
    );
    writeFile(path.join(cwd, ".env"), `OPENCLAW_LOAD_SHELL_ENV=1\nSHELL=${shellPath}\n`);

    const candidates = discoverImportCandidates("openclaw", {
      openclawHome,
      env: {},
      cwd
    });

    expect(fs.existsSync(markerPath)).toBe(false);
    expect(candidates[0]?.kind).toBe("secret");
    if (!candidates[0] || candidates[0].kind !== "secret") {
      throw new Error("Expected OpenClaw shellEnv SecretRef candidate.");
    }
    expect((await resolveSecretImportCandidate(candidates[0])).token).toBe("shell-token");
    expect(fs.existsSync(markerPath)).toBe(true);
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

  it("imports OpenClaw endpoints with access controls disabled", () => {
    const openclawHome = tempDir("aide-openclaw-access-controls-");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  channels: {",
        "    discord: {",
        "      token: 'access-token',",
        "      dmPolicy: 'allowlist',",
        "      allowFrom: ['user:123'],",
        "      groupPolicy: 'allowlist',",
        "      groupAllowFrom: ['channel:456'],",
        "    },",
        "  },",
        "}",
        ""
      ].join("\n")
    );

    const [candidate] = readyImportCandidates(discoverImportCandidates("openclaw", {
      openclawHome,
      env: {},
      cwd: openclawHome
    }));

    expect(candidate?.disabledReason).toBe("OpenClaw access controls need manual review");
    const [entry] = planEndpointImports([], candidate ? [candidate] : []);
    expect(entry).toBeDefined();
    expect(importPlanEntryEndpoint(entry!).enabled).toBe(false);
  });

  it("imports minimal OpenClaw endpoints disabled for default access policies", () => {
    const openclawHome = tempDir("aide-openclaw-default-access-controls-");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  channels: { discord: { token: 'default-policy-token' } },",
        "}",
        ""
      ].join("\n")
    );

    const [candidate] = readyImportCandidates(discoverImportCandidates("openclaw", {
      openclawHome,
      env: {},
      cwd: openclawHome
    }));

    expect(candidate?.disabledReason).toBe("OpenClaw access controls need manual review");
    const [entry] = planEndpointImports([], candidate ? [candidate] : []);
    expect(importPlanEntryEndpoint(entry!).enabled).toBe(false);
  });

  it("keeps OpenClaw endpoints enabled when effective access policies are open", () => {
    const openclawHome = tempDir("aide-openclaw-open-access-controls-");
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  channels: {",
        "    defaults: { groupPolicy: 'open' },",
        "    discord: { dmPolicy: 'open', token: 'open-policy-token' },",
        "  },",
        "}",
        ""
      ].join("\n")
    );

    const [candidate] = readyImportCandidates(discoverImportCandidates("openclaw", {
      openclawHome,
      env: {},
      cwd: openclawHome
    }));

    expect(candidate?.disabledReason).toBeUndefined();
    const [entry] = planEndpointImports([], candidate ? [candidate] : []);
    expect(importPlanEntryEndpoint(entry!).enabled).toBe(true);
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

  it("uses configured OpenClaw SecretRefs before env fallback", async () => {
    const openclawHome = tempDir("aide-openclaw-secret-over-env-");
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

    const [candidate] = discoverImportCandidates("openclaw", {
      openclawHome,
      env: { DISCORD_BOT_TOKEN: "stale-env-token" },
      cwd: openclawHome
    });

    expect(candidate?.kind).toBe("secret");
    if (!candidate || candidate.kind !== "secret") {
      throw new Error("Expected OpenClaw file SecretRef candidate.");
    }
    expect(candidate.endpointId).toBe("openclaw");
    expect((await resolveSecretImportCandidate(candidate)).token).toBe("file-token");
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

  it.each([
    {
      name: "reported errors",
      output: '{"protocolVersion":1,"errors":{"discord/token":{"message":"denied"}}}',
      message: "Exec SecretRef failed for discord/token: denied"
    },
    {
      name: "missing values",
      output: '{"protocolVersion":1,"values":{"other/token":"wrong"}}',
      message: "Exec SecretRef response missing id: discord/token"
    }
  ])("propagates OpenClaw exec JSON protocol failures with plaintext fallback enabled: $name", async ({ output, message }) => {
    const openclawHome = tempDir("aide-openclaw-exec-json-error-");
    const scriptPath = path.join(openclawHome, "resolve-secret.sh");
    writeFile(
      scriptPath,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        `printf '${output}'`,
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
        `      vault: { source: 'exec', command: '${scriptPath}', jsonOnly: false },`,
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
    await expect(resolveSecretImportCandidate(candidate)).rejects.toThrow(message);
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
