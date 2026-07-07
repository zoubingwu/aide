import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import prompts from "prompts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addEndpointCommand } from "../src/commands/endpoints.js";
import { ensureAideHome, loadEndpoints } from "../src/lib/config.js";

vi.mock("execa", () => ({
  execa: vi.fn()
}));

const cleanupPaths: string[] = [];
const restoreCallbacks: Array<() => void> = [];

describe("endpoint commands", () => {
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

  it("keeps interactive command overrides on Codex when Pi is selected", async () => {
    const home = tempDir("aide-endpoint-");
    ensureAideHome(home);
    withStdinTty(true);
    prompts.inject(["pi"]);
    mockExeca()
      .mockResolvedValueOnce({ stdout: "custom codex 1.0.0", stderr: "", exitCode: 0 } as never)
      .mockResolvedValueOnce({ stdout: "0.80.3", stderr: "", exitCode: 0 } as never);

    await addEndpointCommand({
      home,
      provider: "discord",
      id: "discord-pi",
      token: "test-token",
      agentCommand: "custom-codex"
    });

    expect(loadEndpoints(home)[0]?.agent).toMatchObject({
      provider: "pi",
      command: "pi"
    });
  });

  it("applies command overrides to explicit Pi selections", async () => {
    const home = tempDir("aide-endpoint-");
    ensureAideHome(home);
    withStdinTty(false);

    await addEndpointCommand({
      home,
      provider: "discord",
      id: "discord-pi",
      token: "test-token",
      agent: "pi",
      agentCommand: "custom-pi"
    });

    expect(loadEndpoints(home)[0]?.agent).toMatchObject({
      provider: "pi",
      command: "custom-pi"
    });
  });
});

function mockExeca() {
  return vi.mocked(execa);
}

function tempDir(prefix: string): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(target);
  return target;
}

function withStdinTty(value: boolean): void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value
  });
  restoreCallbacks.push(() => {
    if (descriptor) {
      Object.defineProperty(process.stdin, "isTTY", descriptor);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
  });
}
