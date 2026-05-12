import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFiles, openPath } from "../src/lib/open.js";

vi.mock("execa", () => ({
  execa: vi.fn()
}));

const cleanupPaths: string[] = [];

describe("open helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(execa).mockReset();

    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("prints and reveals one path", async () => {
    const root = tempDir();
    const filePath = path.join(root, "config.toml");
    fs.writeFileSync(filePath, "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await openPath(filePath);

    expect(log).toHaveBeenCalledWith(`Path        ${filePath}`);

    if (process.platform === "darwin") {
      expect(execa).toHaveBeenCalledWith("open", ["-R", filePath], { stdio: "inherit" });
      return;
    }

    expect(execa).toHaveBeenCalledWith("xdg-open", [root], { stdio: "inherit" });
  });

  it("prints and reveals multiple paths", async () => {
    const root = tempDir();
    const firstPath = path.join(root, "SOUL.md");
    const secondPath = path.join(root, "AGENTS.md");
    fs.writeFileSync(firstPath, "");
    fs.writeFileSync(secondPath, "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await openFiles([firstPath, secondPath]);

    expect(log).toHaveBeenCalledWith(`Path        ${firstPath}`);
    expect(log).toHaveBeenCalledWith(`Path        ${secondPath}`);

    if (process.platform === "darwin") {
      expect(execa).toHaveBeenCalledWith("open", ["-R", firstPath, secondPath], { stdio: "inherit" });
      return;
    }

    expect(execa).toHaveBeenCalledWith("xdg-open", [root], { stdio: "inherit" });
  });
});

function tempDir(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-open-"));
  cleanupPaths.push(target);
  return target;
}
