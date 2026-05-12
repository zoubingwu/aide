import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { discordPreparationGuide } from "../src/commands/endpoints.js";
import { ensureAideHome, writeConfig } from "../src/lib/config.js";
import packageJson from "../package.json" with { type: "json" };

const cleanupPaths: string[] = [];

describe("CLI help", () => {
  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("shows background start command", async () => {
    const { stdout } = await runCli("--help");

    expect(stdout.split("\n")[0]).toBe(`aide/${packageJson.version}`);
    expect(stdout).toContain("start     Start Aide runtime in the background");
    expect(stdout).toContain("config    List config");
    expect(stdout).toContain("help      Show detailed help");
    expect(stdout).toContain("import    Import endpoints");
    expect(stdout).toContain("schedule  Inspect schedules");
    expect(stdout).toContain("usage     Show usage");
  });

  it("shows doctor fix option", async () => {
    const { stdout } = await runCli("doctor", "--help");

    expect(stdout).toContain("--fix");
    expect(stdout).toContain("Create missing Aide base files and directories");
  });

  it("repairs missing base paths with doctor fix", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");
    fs.rmSync(path.join(home, "schedules.json"), { force: true });
    fs.rmSync(path.join(home, "runtime.json"), { force: true });
    fs.rmSync(path.join(home, "logs"), { recursive: true, force: true });

    const { stdout } = await runCli("--home", home, "doctor", "--fix");

    expect(stdout).toContain("Fixed missing Aide base paths: schedules.json, runtime.json, logs directory.");
    expect(stdout).toContain("✓ schedules.json");
    expect(stdout).toContain("✓ runtime.json");
    expect(fs.existsSync(path.join(home, "schedules.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, "runtime.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, "logs"))).toBe(true);
  });

  it("lists config", async () => {
    const home = tempHome();
    seedEndpointConfig(home);

    const { stdout } = await runCli("--home", home, "config", "list");

    expect(stdout).toContain("Config");
    expect(stdout).toMatch(/endpoints\.discord-main\.token\s+configured/);
    expect(stdout).toMatch(/endpoints\.discord-main\.trigger\.requireMention\s+true/);
    expect(stdout).toMatch(/endpoints\.discord-main\.agent\.provider\s+codex/);
    expect(stdout).toMatch(/endpoints\.discord-main\.agent\.model\s+gpt-5\.5/);
    expect(stdout).toMatch(/endpoints\.discord-main\.agent\.outputMode\s+concise/);
    expect(stdout).not.toContain("test-token");
  });

  it("shows config list help examples", async () => {
    const { stdout } = await runCli("config", "list", "--help");

    expect(stdout).toContain("aide config list");
    expect(stdout).not.toContain("aide config get");
    expect(stdout).not.toContain("aide config set");
  });

  it("rejects removed config get and mutation commands", async () => {
    await expect(runCli("config", "get")).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown command: get")
    });
    await expect(runCli("config", "set", "endpoints.discord.token", "test-token")).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown command: set")
    });
  });

  it("shows endpoint subcommands", async () => {
    const { stdout } = await runCli("endpoint", "--help");

    expect(stdout).toContain("add          Add an endpoint");
    expect(stdout).toContain("config       Manage endpoint config");
    expect(stdout).toContain("aide endpoint add --help");
  });

  it("shows endpoint add options", async () => {
    const { stdout } = await runCli("endpoint", "add", "--help");

    expect(stdout).toContain("$ aide endpoint add");
    expect(stdout).toContain("--provider <provider>");
    expect(stdout).toContain("--token <token>");
    expect(stdout).toContain("--id <id>");
    expect(stdout).toContain("--agent <provider>");
    expect(stdout).toContain("--model <model>");
    expect(stdout).not.toContain("--name <name>");
    expect(stdout).not.toContain("--server <server>");
    expect(stdout).not.toContain("--channel <channel>");
    expect(stdout).not.toContain("--approval-shell");
    expect(stdout).not.toContain("--approval-writes");
  });

  it("mentions Discord history permissions in the setup guide", () => {
    const guide = discordPreparationGuide();

    expect(guide).toContain("Enable Message Content Intent");
    expect(guide).toContain("Grant View Channel, Send Messages, and Read Message History");
  });

  it("shows endpoint config subcommands", async () => {
    const { stdout } = await runCli("endpoint", "config", "--help");

    expect(stdout).toContain("$ aide endpoint config <command> [options]");
    expect(stdout).toContain("list <id>  List endpoint config files");
    expect(stdout).toContain("open <id>  Reveal endpoint config files");
  });

  it("shows schedule subcommands", async () => {
    const { stdout } = await runCli("schedule", "--help");

    expect(stdout).toContain("list    List schedules");
    expect(stdout).toContain("show    Show schedule details");
    expect(stdout).toContain("config  Manage schedule config");
    expect(stdout).not.toContain("add <prompt>");
    expect(stdout).not.toContain("pause");
    expect(stdout).not.toContain("resume");
    expect(stdout).not.toContain("remove");
  });

  it("rejects removed schedule mutation commands", async () => {
    await expect(
      runCli(
        "schedule",
        "add",
        "One-off reminder.",
        "--id",
        "launch-reminder",
        "--kind",
        "once",
        "--endpoint",
        "discord",
        "--target",
        "channel:123",
        "--run-at",
        "2026-05-08T09:00:00+08:00"
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Unknown command: add")
    });
  });

  it("lists and shows a cron schedule", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");
    writeSchedules(home, [
      {
        id: "failed-jobs",
        endpoint: "discord-main",
        enabled: true,
        kind: "cron",
        target: "channel:123",
        message: "Check failed jobs.",
        cron: "*/15 * * * *",
        timezone: "Asia/Shanghai"
      }
    ]);

    const list = await runCli("--home", home, "schedule", "list");
    const show = await runCli("--home", home, "schedule", "show", "--id", "failed-jobs");

    expect(list.stdout).toContain("failed-jobs");
    expect(show.stdout).toContain("Kind       cron");
    expect(show.stdout).toContain("Cron       */15 * * * *");
  });

  it("lists and shows a paused daily schedule", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");
    writeSchedules(home, [
      {
        id: "daily-brief",
        endpoint: "discord-main",
        enabled: false,
        kind: "daily",
        target: "channel:123",
        message: "Generate my daily brief.",
        time: "09:00",
        timezone: "Asia/Shanghai"
      }
    ]);

    const { stdout } = await runCli("--home", home, "schedule", "list");
    expect(stdout).toContain("daily-brief");
    expect(stdout).toContain("daily");
    expect(stdout).toContain("discord-main");

    const show = await runCli("--home", home, "schedule", "show", "--id", "daily-brief");
    expect(show.stdout).toContain("Message    Generate my daily brief.");
    expect(show.stdout).toContain("Status     paused");
  });

  it("shows service subcommands", async () => {
    const { stdout } = await runCli("service", "--help");

    expect(stdout).toContain("install    Install runtime service");
    expect(stdout).toContain("uninstall  Uninstall runtime service");
    expect(stdout).toContain("status     Show service status");
  });

  it("shows agent-facing help", async () => {
    const { stdout } = await runCli("help", "agent");

    expect(stdout).toContain("Aide Agent Guide");
    expect(stdout).toContain("Source: channel:<id>");
    expect(stdout).toContain("Config: <home>/config.toml");
    expect(stdout).toContain("Schedules: <home>/schedules.json");
    expect(stdout).toContain('trigger = { requireMention = true, freeResponseSources = ["channel:123"] }');
    expect(stdout).toContain('agent = { provider = "codex", command = "codex", model = "gpt-5.5", reasoningEffort = "medium", outputMode = "concise" }');
    expect(stdout).toContain("Trigger settings are per endpoint.");
    expect(stdout).toContain("Mention-free server-channel triggers require Message Content Intent");
    expect(stdout).toContain("When a user asks to make the current Discord channel mention-free");
    expect(stdout).toContain("Root shape: { \"schedules\": [] }");
    expect(stdout).toContain('"kind": "cron"');
    expect(stdout).toContain('"kind": "once"');
    expect(stdout).toContain("Use kind \"cron\" with cron for exact schedules.");
    expect(stdout).toContain("Use kind \"once\" with runAt for delayed reminders");
    expect(stdout).toContain("Shell sleeps and long-running waits are unsuitable for reminder requests.");
    expect(stdout).toContain("Manual schedule file changes apply after aide restart.");
    expect(stdout).toContain("Run aide doctor after file edits.");
    expect(stdout).not.toContain("aide config set");
    expect(stdout).not.toContain("aide schedule add");
  });

  it("supports global options before endpoint", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");
    await runCli(
      "--home",
      home,
      "endpoint",
      "add",
      "--id",
      "discord-agent-ops",
      "--token",
      "test-token"
    );

    const { stdout } = await runCli("--home", home, "endpoint", "list");
    expect(stdout).toContain("discord-agent-ops");

    const configToml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    expect(configToml).toContain('id = "discord-agent-ops"');
    expect(configToml).toContain('token = "test-token"');
    expect(configToml).toContain('provider = "codex"');
    expect(configToml).toContain('command = "codex"');
    expect(configToml).toContain('model = "gpt-5.5"');
    expect(configToml).toContain('reasoningEffort = "medium"');
    expect(configToml).toContain('outputMode = "concise"');
    expect(configToml).toContain("requireMention = true");
    expect(configToml).toContain("freeResponseSources = []");
    expect(fs.existsSync(path.join(home, ".env.local"))).toBe(false);
    expect(configToml).not.toContain("workspacePath");
    expect(configToml).not.toContain("routing");
    expect(configToml).not.toContain("permissions");
  });

  it("requires endpoint id for scripted Discord add", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");

    await expect(runCli("--home", home, "endpoint", "add", "--token", "test-token")).rejects.toMatchObject({
      stderr: expect.stringContaining("Missing endpoint id. Provide --id <id>.")
    });
  });

  it("rejects unsupported endpoint providers", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");

    await expect(
      runCli("--home", home, "endpoint", "add", "--provider", "slack", "--id", "chat", "--token", "test-token")
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Endpoint provider must be one of: discord.")
    });
  });

  it("rejects positional endpoint providers for add", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");

    await expect(
      runCli("--home", home, "endpoint", "add", "slack", "--id", "chat", "--token", "test-token")
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Unexpected endpoint provider argument: slack.")
    });

    const configToml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    expect(configToml).toContain("endpoints = []");
  });

  it("logs hidden runtime startup errors", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");
    await runCli("--home", home, "endpoint", "add", "--id", "broken", "--token", "test-token");
    fs.rmSync(path.join(home, "workspace", "broken"), { recursive: true, force: true });

    await expect(runCli("--home", home, "start")).rejects.toMatchObject({
      stderr: expect.stringContaining("child exited with code 1")
    });

    const log = fs.readFileSync(path.join(home, "logs", "runtime.log"), "utf8");
    expect(log).toContain("runtime_internal_error");
    expect(log).toContain("Endpoint workspace is missing");
    expect(log).toContain("runtime_background_start_failed");
    expect(log).toContain("\"exitCode\":1");
  });
});

function runCli(...args: string[]) {
  return execa("bun", ["src/cli.ts", ...args], {
    cwd: process.cwd()
  });
}

function seedEndpointConfig(home: string): void {
  ensureAideHome(home);
  writeConfig(home, {
    endpoints: [
      {
        id: "discord-main",
        provider: "discord",
        enabled: true,
        token: "test-token",
        trigger: {
          requireMention: true,
          freeResponseSources: []
        },
        agent: {
          provider: "codex",
          command: "codex",
          model: "gpt-5.5",
          reasoningEffort: "medium",
          outputMode: "concise"
        }
      }
    ]
  });
}

function writeSchedules(home: string, schedules: unknown[]): void {
  fs.writeFileSync(path.join(home, "schedules.json"), `${JSON.stringify({ schedules }, null, 2)}\n`);
}

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-cli-help-"));
  cleanupPaths.push(target);
  return target;
}
