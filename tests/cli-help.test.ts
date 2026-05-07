import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

const cleanupPaths: string[] = [];

describe("CLI help", () => {
  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("shows background start command", async () => {
    const { stdout } = await runCli("--help");

    expect(stdout).toContain("start     Start Aide runtime in the background");
    expect(stdout).toContain("config    Manage config");
    expect(stdout).toContain("help      Show detailed help");
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

  it("gets and sets config", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");
    await runCli("--home", home, "endpoint", "add", "discord", "--id", "discord-main", "--token", "test-token");

    await runCli("--home", home, "config", "set", "endpoints.discord-main.agent.model", "gpt-5.4");
    await runCli("--home", home, "config", "set", "endpoints.discord-main.agent.reasoningEffort", "high");
    await runCli("--home", home, "config", "set", "endpoints.discord-main.token", "new-token");
    await runCli("--home", home, "config", "set", "runtime.startupTimeoutMs", "45000");

    const model = await runCli("--home", home, "config", "get", "endpoints.discord-main.agent.model");
    const token = await runCli("--home", home, "config", "get", "endpoints.discord-main.token");
    const config = fs.readFileSync(path.join(home, "config.toml"), "utf8");

    expect(model.stdout).toContain('endpoints.discord-main.agent.model = "gpt-5.4"');
    expect(token.stdout).toContain('endpoints.discord-main.token = "configured"');
    expect(config).toContain('model = "gpt-5.4"');
    expect(config).toContain('reasoningEffort = "high"');
    expect(config).toContain('token = "new-token"');
    expect(config).toContain("startupTimeoutMs = 45_000");
  });

  it("shows config help examples", async () => {
    const { stdout } = await runCli("config", "set", "--help");

    expect(stdout).toContain("endpoints.<id>.agent.model");
    expect(stdout).toContain("endpoints.<id>.agent.reasoningEffort");
    expect(stdout).toContain("endpoints.<id>.token");
    expect(stdout).toContain("aide config set endpoints.discord.agent.reasoningEffort high");
  });

  it("shows endpoint subcommands", async () => {
    const { stdout } = await runCli("endpoint", "--help");

    expect(stdout).toContain("add <provider>  Add an endpoint");
    expect(stdout).toContain("config          Manage endpoint config");
    expect(stdout).toContain("aide endpoint add --help");
  });

  it("shows endpoint add options", async () => {
    const { stdout } = await runCli("endpoint", "add", "--help");

    expect(stdout).toContain("$ aide endpoint add <provider>");
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

  it("shows endpoint config subcommands", async () => {
    const { stdout } = await runCli("endpoint", "config", "--help");

    expect(stdout).toContain("$ aide endpoint config <command> [options]");
    expect(stdout).toContain("list <id>  List endpoint config files");
    expect(stdout).toContain("open <id>  Open endpoint config files");
  });

  it("shows schedule subcommands", async () => {
    const { stdout } = await runCli("schedule", "--help");

    expect(stdout).toContain("add <prompt>  Add a schedule");
    expect(stdout).toContain("list          List schedules");
    expect(stdout).toContain("config        Manage schedule config");
  });

  it("shows schedule add examples and enum values", async () => {
    const { stdout } = await runCli("schedule", "add", "--help");

    expect(stdout).toContain("cron | hourly | daily | weekly | biweekly | monthly | once");
    expect(stdout).toContain("Cron: 5 fields, minute hour day-of-month month day-of-week");
    expect(stdout).toContain("sunday | monday | tuesday | wednesday | thursday | friday | saturday");
    expect(stdout).toContain('aide schedule add "Check failed jobs."');
    expect(stdout).toContain("--kind <kind>");
    expect(stdout).toContain("--cron <expression>");
  });

  it("adds and lists a cron schedule", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");

    await runCli(
      "--home",
      home,
      "schedule",
      "add",
      "Check failed jobs.",
      "--id",
      "failed-jobs",
      "--kind",
      "cron",
      "--cron",
      "*/15 * * * *",
      "--endpoint",
      "discord-main",
      "--timezone",
      "Asia/Shanghai",
      "--target",
      "channel:123"
    );

    const { stdout } = await runCli("--home", home, "schedule", "show", "--id", "failed-jobs");
    const schedules = fs.readFileSync(path.join(home, "schedules.json"), "utf8");

    expect(stdout).toContain("Kind       cron");
    expect(stdout).toContain("Cron       */15 * * * *");
    expect(schedules).toContain('"cron": "*/15 * * * *"');
  });

  it("adds and lists a daily schedule", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");

    await runCli(
      "--home",
      home,
      "schedule",
      "add",
      "Generate my daily brief.",
      "--id",
      "daily-brief",
      "--kind",
      "daily",
      "--endpoint",
      "discord-main",
      "--time",
      "09:00",
      "--timezone",
      "Asia/Shanghai",
      "--target",
      "channel:123"
    );

    const { stdout } = await runCli("--home", home, "schedule", "list");
    expect(stdout).toContain("daily-brief");
    expect(stdout).toContain("daily");
    expect(stdout).toContain("discord-main");

    const show = await runCli("--home", home, "schedule", "show", "--id", "daily-brief");
    expect(show.stdout).toContain("Message    Generate my daily brief.");

    await runCli("--home", home, "schedule", "pause", "--id", "daily-brief");
    const paused = await runCli("--home", home, "schedule", "show", "--id", "daily-brief");
    expect(paused.stdout).toContain("Status     paused");
  });

  it("rejects non-numeric hourly minute values", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");

    await expect(
      runCli(
        "--home",
        home,
        "schedule",
        "add",
        "Generate my hourly brief.",
        "--id",
        "hourly-brief",
        "--kind",
        "hourly",
        "--endpoint",
        "discord-main",
        "--minute",
        "abc",
        "--target",
        "channel:123"
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Invalid numeric option: --minute")
    });
  });

  it("rejects non-numeric monthly day values", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");

    await expect(
      runCli(
        "--home",
        home,
        "schedule",
        "add",
        "Generate my monthly brief.",
        "--id",
        "monthly-brief",
        "--kind",
        "monthly",
        "--endpoint",
        "discord-main",
        "--day",
        "foo",
        "--time",
        "09:00",
        "--target",
        "channel:123"
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Invalid numeric option: --day")
    });
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
    expect(stdout).toContain("aide config set endpoints.discord.agent.model gpt-5.5");
    expect(stdout).toContain("aide schedule add <prompt>");
    expect(stdout).toContain("Agents should prefer --kind cron with --cron for exact schedules.");
    expect(stdout).toContain("Agents should use --kind once with --run-at for delayed reminders");
    expect(stdout).toContain("Shell sleeps and long-running waits are unsuitable for reminder requests.");
    expect(stdout).toContain("Schedule changes reload the running runtime immediately");
  });

  it("supports global options before endpoint", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");
    await runCli(
      "--home",
      home,
      "endpoint",
      "add",
      "discord",
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
    expect(fs.existsSync(path.join(home, ".env.local"))).toBe(false);
    expect(configToml).not.toContain("workspacePath");
    expect(configToml).not.toContain("routing");
    expect(configToml).not.toContain("permissions");
  });

  it("requires endpoint id for scripted Discord add", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");

    await expect(runCli("--home", home, "endpoint", "add", "discord", "--token", "test-token")).rejects.toMatchObject({
      stderr: expect.stringContaining("Missing endpoint id. Provide --id <id>.")
    });
  });

  it("logs hidden runtime startup errors", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");
    await runCli("--home", home, "endpoint", "add", "discord", "--id", "broken", "--token", "test-token");
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

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-cli-help-"));
  cleanupPaths.push(target);
  return target;
}
