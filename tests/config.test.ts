import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAideHome, loadConfig, loadEndpoints, writeConfig } from "../src/lib/config.js";
import { configPath, logsDir, pendingDeliveriesPath, schedulesPath, usagePath, workspaceDir } from "../src/lib/paths.js";

const cleanupPaths: string[] = [];

describe("config", () => {
  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("initializes Aide home with required files and directories", () => {
    const home = tempHome();

    ensureAideHome(home);

    expect(fs.existsSync(configPath(home))).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(configPath(home)).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(schedulesPath(home))).toBe(true);
    expect(path.basename(schedulesPath(home))).toBe("schedules.json");
    expect(fs.existsSync(pendingDeliveriesPath(home))).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(pendingDeliveriesPath(home)).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(usagePath(home))).toBe(true);
    expect(fs.readFileSync(usagePath(home), "utf8")).toBe("");
    expect(fs.existsSync(logsDir(home))).toBe(true);
    expect(fs.existsSync(workspaceDir(home))).toBe(true);
    expect(fs.readFileSync(configPath(home), "utf8")).not.toContain("home =");
    expect(loadConfig(home).endpoints).toEqual([]);
    expect(loadEndpoints(home)).toEqual([]);
  });

  it("strips legacy config metadata fields on write", () => {
    const home = tempHome();
    ensureAideHome(home);
    fs.writeFileSync(
      configPath(home),
      'home = "~/.aide"\nendpoints = []\n\n[runtime]\nstartupTimeoutMs = 30000\n'
    );

    const config = loadConfig(home);
    writeConfig(home, config);
    const content = fs.readFileSync(configPath(home), "utf8");

    expect(config).toEqual({ endpoints: [] });
    expect(content).not.toContain("home =");
    expect(content).not.toContain("[runtime]");
    expect(content).not.toContain("startupTimeoutMs");
  });

  it("writes endpoint trigger and agent config as inline endpoint fields", () => {
    const home = tempHome();
    ensureAideHome(home);

    writeConfig(home, {
      endpoints: [
        {
          id: "discord-main",
          provider: "discord",
          enabled: true,
          token: "test-token",
          trigger: {
            requireMention: false,
            freeResponseSources: ["channel:123", "channel:456"]
          },
          agent: {
            provider: "codex",
            command: "codex",
            model: "gpt-5.5",
            reasoningEffort: "high",
            outputMode: "verbose"
          }
        }
      ]
    });

    const content = fs.readFileSync(configPath(home), "utf8");

    expect(content).toContain('trigger = { requireMention = false, freeResponseSources = [ "channel:123", "channel:456" ] }');
    expect(content).toContain('agent = { provider = "codex", command = "codex", model = "gpt-5.5", reasoningEffort = "high", outputMode = "verbose" }');
    expect(content).not.toContain("[endpoints.trigger]");
    expect(content).not.toContain("[endpoints.agent]");
    expect(loadEndpoints(home)[0]?.trigger.freeResponseSources).toEqual(["channel:123", "channel:456"]);
    expect(loadEndpoints(home)[0]?.agent.reasoningEffort).toBe("high");
    expect(loadEndpoints(home)[0]?.agent.outputMode).toBe("verbose");
  });

  it("defaults missing endpoint trigger config", () => {
    const home = tempHome();
    ensureAideHome(home);
    fs.writeFileSync(
      configPath(home),
      `[[endpoints]]
id = "discord"
provider = "discord"
enabled = true
token = "test-token"

[endpoints.agent]
provider = "codex"
command = "codex"
model = "gpt-5.5"
reasoningEffort = "medium"
`
    );

    const [endpoint] = loadEndpoints(home);

    expect(endpoint?.trigger).toEqual({
      requireMention: true,
      freeResponseSources: []
    });
    expect(endpoint?.agent.outputMode).toBe("concise");
  });

  it("tightens an existing config file during initialization", () => {
    if (process.platform === "win32") {
      return;
    }

    const home = tempHome();
    ensureAideHome(home);
    fs.chmodSync(configPath(home), 0o644);

    ensureAideHome(home);

    expect(fs.statSync(configPath(home)).mode & 0o777).toBe(0o600);
  });

  it("tightens an existing pending deliveries file during initialization", () => {
    if (process.platform === "win32") {
      return;
    }

    const home = tempHome();
    ensureAideHome(home);
    fs.chmodSync(pendingDeliveriesPath(home), 0o644);

    ensureAideHome(home);

    expect(fs.statSync(pendingDeliveriesPath(home)).mode & 0o777).toBe(0o600);
  });

  it("tightens an existing config file when loading config", () => {
    if (process.platform === "win32") {
      return;
    }

    const home = tempHome();
    ensureAideHome(home);
    fs.chmodSync(configPath(home), 0o644);

    loadConfig(home);

    expect(fs.statSync(configPath(home)).mode & 0o777).toBe(0o600);
  });
});

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-config-"));
  cleanupPaths.push(target);
  return target;
}
