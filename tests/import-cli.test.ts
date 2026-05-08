import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";

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
    expect(stdout).not.toContain("file-token");
    expect(config).toContain("endpoints = []");
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
