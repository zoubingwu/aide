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

  it("shows endpoint subcommands", async () => {
    const { stdout } = await runCli("endpoint", "--help");

    expect(stdout).toContain("add <provider>  Add an endpoint");
    expect(stdout).toContain("config          Manage endpoint config");
    expect(stdout).toContain("aide endpoint add --help");
  });

  it("shows endpoint add options", async () => {
    const { stdout } = await runCli("endpoint", "add", "--help");

    expect(stdout).toContain("$ aide endpoint add <provider>");
    expect(stdout).toContain("--server <server>");
    expect(stdout).toContain("--approval-writes");
  });

  it("shows endpoint config subcommands", async () => {
    const { stdout } = await runCli("endpoint", "config", "--help");

    expect(stdout).toContain("$ aide endpoint config <command> [options]");
    expect(stdout).toContain("list <id>  List endpoint config files");
    expect(stdout).toContain("open <id>  Open endpoint config files");
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
      "test-token",
      "--server",
      "agent-lab",
      "--channel",
      "agent-ops"
    );

    const { stdout } = await runCli("--home", home, "endpoint", "list");
    expect(stdout).toContain("discord-agent-ops");
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
