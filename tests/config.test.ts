import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAideHome, loadConfig, loadEndpoints } from "../src/lib/config.js";
import { configPath, endpointsPath, logsDir, schedulesPath, usagePath, workspaceDir } from "../src/lib/paths.js";

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
    expect(fs.existsSync(endpointsPath(home))).toBe(true);
    expect(fs.existsSync(schedulesPath(home))).toBe(true);
    expect(fs.existsSync(usagePath(home))).toBe(true);
    expect(fs.readFileSync(usagePath(home), "utf8")).toBe("");
    expect(fs.existsSync(logsDir(home))).toBe(true);
    expect(fs.existsSync(workspaceDir(home))).toBe(true);
    expect(loadConfig(home).runtime.provider).toBe("codex");
    expect(loadConfig(home).runtime.args).toEqual([
      "exec",
      "resume",
      "--last",
      "--json",
      "--skip-git-repo-check"
    ]);
    expect(loadEndpoints(home)).toEqual([]);
  });
});

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-config-"));
  cleanupPaths.push(target);
  return target;
}
