import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentProviderLabel,
  defaultAgentConfig,
  detectInstalledAgents,
  parseAgentProvider
} from "../src/lib/agents.js";

vi.mock("execa", () => ({
  execa: vi.fn()
}));

describe("agents", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("detects installed Codex CLI from the agent catalog", async () => {
    mockExeca().mockResolvedValueOnce({
      stdout: "codex 1.0.0",
      stderr: "",
      exitCode: 0
    } as never);

    await expect(detectInstalledAgents()).resolves.toEqual([
      {
        provider: "codex",
        label: "Codex",
        command: "codex",
        version: "codex 1.0.0"
      }
    ]);
  });

  it("skips missing CLI agent commands", async () => {
    mockExeca().mockRejectedValueOnce(new Error("spawn codex ENOENT"));

    await expect(detectInstalledAgents()).resolves.toEqual([]);
  });

  it("returns full Codex defaults for endpoint config", () => {
    expect(defaultAgentConfig("codex")).toEqual({
      provider: "codex",
      command: "codex",
      model: "gpt-5.5",
      reasoningEffort: "medium"
    });
    expect(agentProviderLabel("codex")).toBe("Codex");
    expect(parseAgentProvider("codex")).toBe("codex");
  });
});

function mockExeca(): {
  mockResolvedValueOnce(value: unknown): ReturnType<typeof mockExeca>;
  mockRejectedValueOnce(value: unknown): ReturnType<typeof mockExeca>;
} {
  return execa as unknown as ReturnType<typeof mockExeca>;
}
