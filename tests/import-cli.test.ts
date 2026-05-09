import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import prompts from "prompts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importCommand } from "../src/commands/import.js";

const cleanupPaths: string[] = [];

describe("import CLI", () => {
  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("imports Hermes profiles into Aide endpoints without printing tokens", async () => {
    const aideHome = tempDir("aide-import-home-");
    const hermesHome = tempDir("aide-import-hermes-");
    writeFile(path.join(hermesHome, ".env"), "DISCORD_BOT_TOKEN=default-token\n");
    writeFile(path.join(hermesHome, "profiles", "work", ".env"), "DISCORD_BOT_TOKEN=work-token\n");

    const { stdout } = await runCli(
      ["--home", aideHome, "import", "hermes"],
      { HERMES_HOME: hermesHome, DISCORD_BOT_TOKEN: undefined }
    );
    const config = fs.readFileSync(path.join(aideHome, "config.toml"), "utf8");

    expect(stdout).toContain("hermes");
    expect(stdout).toContain("Discovered endpoints");
    expect(stdout).toContain("Import plan");
    expect(stdout).toContain("hermes-work");
    expect(stdout).toContain("Imported hermes");
    expect(stdout).not.toContain("default-token");
    expect(stdout).not.toContain("work-token");
    expect(config).toContain('id = "hermes"');
    expect(config).toContain('token = "default-token"');
    expect(config).toContain('id = "hermes-work"');
    expect(config).toContain('token = "work-token"');
    expect(fs.existsSync(path.join(aideHome, "workspace", "hermes"))).toBe(true);
    expect(fs.existsSync(path.join(aideHome, "workspace", "hermes-work"))).toBe(true);
  });

  it("shows import help", async () => {
    const { stdout } = await runCli(["import", "--help"]);

    expect(stdout).toContain("aide import");
    expect(stdout).toContain("Import endpoints from hermes, openclaw, or all");
  });

  it("skips OpenClaw file SecretRefs in scripted imports", async () => {
    const aideHome = tempDir("aide-import-home-");
    const openclawHome = tempDir("aide-import-openclaw-");
    const secretPath = path.join(openclawHome, "secrets.json");
    writeFile(secretPath, JSON.stringify({ discord: { token: "file-token" } }));
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  secrets: { providers: { localfile: { source: 'file', path: '" + secretPath + "', mode: 'json' } } },",
        "  channels: { discord: { token: { source: 'file', provider: 'localfile', id: '/discord/token' } } },",
        "}",
        ""
      ].join("\n")
    );

    const { stdout } = await runCli(["--home", aideHome, "import", "openclaw"], {
      OPENCLAW_CONFIG_PATH: path.join(openclawHome, "openclaw.json")
    });
    const config = fs.readFileSync(path.join(aideHome, "config.toml"), "utf8");

    expect(stdout).toContain("SecretRef requires confirmation");
    expect(stdout).toContain("Discovered endpoints");
    expect(stdout).toContain("SecretRef file");
    expect(stdout).toContain("No importable Discord bot tokens found.");
    expect(stdout).not.toContain("file-token");
    expect(config).toContain("endpoints = []");
  });

  it("preserves OpenClaw discovery order after confirmed SecretRefs", async () => {
    const aideHome = tempDir("aide-import-home-");
    const openclawHome = tempDir("aide-import-openclaw-");
    const secretPath = path.join(openclawHome, "secrets.json");
    writeFile(secretPath, JSON.stringify({ discord: { token: "shared-token" } }));
    writeFile(
      path.join(openclawHome, "openclaw.json"),
      [
        "{",
        "  secrets: { providers: { localfile: { source: 'file', path: '" + secretPath + "', mode: 'json' } } },",
        "  channels: {",
        "    discord: {",
        "      token: { source: 'file', provider: 'localfile', id: '/discord/token' },",
        "      accounts: { work: { token: 'shared-token' } },",
        "    },",
        "  },",
        "}",
        ""
      ].join("\n")
    );

    const env = withEnv("OPENCLAW_CONFIG_PATH", path.join(openclawHome, "openclaw.json"));
    const stdin = withStdinTty(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    prompts.inject([true, true]);

    try {
      await importCommand("openclaw", { home: aideHome });
    } finally {
      log.mockRestore();
      stdin.restore();
      env.restore();
    }

    const config = fs.readFileSync(path.join(aideHome, "config.toml"), "utf8");
    expect(config).toContain('id = "openclaw"');
    expect(config).toContain('token = "shared-token"');
    expect(config).not.toContain('id = "openclaw-work"');
  });
});

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return execa("bun", ["src/cli.ts", ...args], {
    cwd: process.cwd(),
    env
  });
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

function withEnv(key: string, value: string): { restore: () => void } {
  const previous = process.env[key];
  process.env[key] = value;

  return {
    restore: () => {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = previous;
      }
    }
  };
}

function withStdinTty(value: boolean): { restore: () => void } {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });

  return {
    restore: () => {
      if (descriptor) {
        Object.defineProperty(process.stdin, "isTTY", descriptor);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
    }
  };
}
