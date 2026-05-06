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

    expect(stdout).toContain("add <kind>   Add a schedule");
    expect(stdout).toContain("list         List schedules");
    expect(stdout).toContain("config       Manage schedule config");
  });

  it("adds and lists a daily schedule", async () => {
    const home = tempHome();
    await runCli("--home", home, "init");

    await runCli(
      "--home",
      home,
      "schedule",
      "add",
      "daily",
      "--id",
      "daily-brief",
      "--endpoint",
      "discord-main",
      "--time",
      "09:00",
      "--timezone",
      "Asia/Shanghai",
      "--target",
      "channel:123",
      "--message",
      "Generate my daily brief."
    );

    const { stdout } = await runCli("--home", home, "schedule", "list");
    expect(stdout).toContain("daily-brief");
    expect(stdout).toContain("daily");
    expect(stdout).toContain("discord-main");
  });

  it("shows service subcommands", async () => {
    const { stdout } = await runCli("service", "--help");

    expect(stdout).toContain("install    Install runtime service");
    expect(stdout).toContain("uninstall  Uninstall runtime service");
    expect(stdout).toContain("status     Show service status");
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

    const endpointsToml = fs.readFileSync(path.join(home, "endpoints.toml"), "utf8");
    expect(endpointsToml).toContain('id = "discord-agent-ops"');
    expect(endpointsToml).not.toContain("workspacePath");
    expect(endpointsToml).not.toContain("routing");
    expect(endpointsToml).not.toContain("permissions");
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
