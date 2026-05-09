import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import prompts from "prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initCommand } from "../src/commands/system.js";
import {
  defaultCodexAgentConfig,
  defaultEndpointTriggerConfig,
  ensureAideHome,
  loadEndpoints,
  writeEndpoints,
  writeRuntimeState
} from "../src/lib/config.js";
import { configPath } from "../src/lib/paths.js";
import { ensureEndpointWorkspace } from "../src/lib/workspace.js";
import type { Endpoint } from "../src/lib/types.js";

vi.mock("execa", () => ({
  execa: vi.fn()
}));

const cleanupPaths: string[] = [];
const restoreCallbacks: Array<() => void> = [];

describe("init onboarding", () => {
  beforeEach(() => {
    mockExeca().mockResolvedValue({ exitCode: 0, stdout: "codex 1.0.0", stderr: "" } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    prompts.inject([]);

    for (const restore of restoreCallbacks.splice(0)) {
      restore();
    }

    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("keeps scripted init as filesystem bootstrap with next steps", async () => {
    const home = tempDir("aide-init-home-");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    withStdinTty(false);

    await initCommand({ home });

    const output = loggedText(log);
    expect(fs.existsSync(configPath(home))).toBe(true);
    expect(output).toContain("Aide initialized at");
    expect(output).toContain("Next Aide steps:");
    expect(output).toContain("aide endpoint add");
    expect(mockExeca()).not.toHaveBeenCalled();
  });

  it("treats repeated interactive init as a setup check for existing endpoints", async () => {
    const home = tempDir("aide-init-home-");
    seedDiscoveryEnv();
    withStdinTty(true);
    prompts.inject([false]);
    ensureAideHome(home);
    const endpoint = discordEndpoint();
    writeEndpoints(home, [endpoint]);
    ensureEndpointWorkspace(home, endpoint);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await initCommand({ home });

    const output = loggedText(log);
    expect(loadEndpoints(home)).toHaveLength(1);
    expect(output).toContain("CLI agents");
    expect(output).toContain("Aide Doctor");
    expect(output).toContain("Run `aide start` when ready.");
    expect(output).not.toContain("Discord setup before continuing");
  });

  it("imports discovered Hermes endpoints during interactive init", async () => {
    const home = tempDir("aide-init-home-");
    const hermesHome = tempDir("aide-init-hermes-");
    seedDiscoveryEnv({ hermesHome });
    writeFile(path.join(hermesHome, ".env"), "DISCORD_BOT_TOKEN=hermes-token\n");
    withStdinTty(true);
    prompts.inject([true, false]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await initCommand({ home });

    const output = loggedText(log);
    const config = fs.readFileSync(configPath(home), "utf8");
    expect(loadEndpoints(home).map((endpoint) => endpoint.id)).toEqual(["hermes"]);
    expect(config).toContain('token = "hermes-token"');
    expect(output).toContain("Imported:");
    expect(output).toContain("hermes");
    expect(output).not.toContain("hermes-token");
  });

  it("prompts for restart when imports add endpoints to a running runtime", async () => {
    const home = tempDir("aide-init-home-");
    const hermesHome = tempDir("aide-init-hermes-");
    seedDiscoveryEnv({ hermesHome });
    writeFile(path.join(hermesHome, ".env"), "DISCORD_BOT_TOKEN=hermes-token\n");
    ensureAideHome(home);
    writeRuntimeState(home, {
      status: "running",
      home,
      pid: process.pid,
      startedAt: new Date("2026-05-09T00:00:00.000Z").toISOString()
    });
    withStdinTty(true);
    prompts.inject([true, false]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await initCommand({ home });

    const output = loggedText(log);
    expect(loadEndpoints(home).map((endpoint) => endpoint.id)).toEqual(["hermes"]);
    expect(output).toContain("Run `aide restart` to use imported endpoints.");
    expect(output).not.toContain("Aide runtime is running with PID");
  });
});

function mockExeca() {
  return vi.mocked(execa);
}

function loggedText(log: { mock: { calls: unknown[][] } }): string {
  return log.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

function discordEndpoint(): Endpoint {
  return {
    id: "discord",
    provider: "discord",
    enabled: true,
    token: "test-token",
    trigger: defaultEndpointTriggerConfig(),
    agent: defaultCodexAgentConfig()
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

function seedDiscoveryEnv(options: { hermesHome?: string } = {}): void {
  setEnv("HERMES_HOME", options.hermesHome ?? tempDir("aide-init-empty-hermes-"));
  setEnv("OPENCLAW_STATE_DIR", tempDir("aide-init-openclaw-"));
  setEnv("OPENCLAW_CONFIG_PATH", undefined);
  setEnv("DISCORD_BOT_TOKEN", undefined);
}

function setEnv(key: string, value: string | undefined): void {
  const previous = process.env[key];

  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }

  restoreCallbacks.push(() => {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = previous;
    }
  });
}

function withStdinTty(value: boolean): void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
  restoreCallbacks.push(() => {
    if (descriptor) {
      Object.defineProperty(process.stdin, "isTTY", descriptor);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
  });
}
