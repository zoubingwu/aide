import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import {
  buildCodexArgs,
  buildFreshCodexArgs,
  extractFinalResponse,
  runCodex
} from "../src/lib/codex.js";
import { ACTIVITY_LOG_FILE } from "../src/lib/logging.js";
import { logsDir } from "../src/lib/paths.js";
import type { Endpoint, RuntimeConfig } from "../src/lib/types.js";

vi.mock("execa", () => ({
  execa: vi.fn()
}));

const runtimeConfig: RuntimeConfig = {
  provider: "codex",
  command: "codex",
  args: ["exec", "resume", "--last", "--json", "--skip-git-repo-check"],
  model: "gpt-5.5",
  reasoningEffort: "medium",
  startupTimeoutMs: 30_000
};

const endpoint: Endpoint = {
  id: "yaya",
  provider: "discord",
  enabled: true
};

describe("codex", () => {
  afterEach(() => {
    vi.clearAllMocks();

    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("builds resume-last exec args with prompt at the end", () => {
    expect(buildCodexArgs(runtimeConfig, "hello")).toEqual([
      "exec",
      "--model",
      "gpt-5.5",
      "-c",
      "model_reasoning_effort=\"medium\"",
      "resume",
      "--last",
      "--json",
      "--skip-git-repo-check",
      "hello"
    ]);
  });

  it("builds fresh exec args for first-run fallback", () => {
    expect(buildFreshCodexArgs(runtimeConfig, "hello")).toEqual([
      "exec",
      "--model",
      "gpt-5.5",
      "-c",
      "model_reasoning_effort=\"medium\"",
      "--json",
      "--skip-git-repo-check",
      "hello"
    ]);
  });

  it("extracts final text from JSONL output", () => {
    const output = [
      JSON.stringify({ type: "event", message: "working" }),
      JSON.stringify({ type: "final", final_response: "done" })
    ].join("\n");

    expect(extractFinalResponse(output)).toBe("done");
  });

  it("uses stderr when stdout has no text", () => {
    expect(extractFinalResponse("", "missing session")).toBe("missing session");
  });

  it("logs Codex CLI JSONL output", async () => {
    const home = tempHome();
    const workspace = tempHome();
    const stdout = JSON.stringify({ type: "final", final_response: "done" });

    mockExeca().mockResolvedValueOnce({
      stdout,
      stderr: "",
      exitCode: 0
    } as never);

    const result = await runCodex({ home, runtime: runtimeConfig }, home, workspace, endpoint, "hello");
    const events = readActivityEvents(home);

    expect(result.response).toBe("done");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      endpoint: "yaya",
      event: "codex_cli_started",
      metadata: {
        attempt: "resume",
        command: "codex",
        args: expect.arrayContaining(["{prompt}"]),
        cwd: workspace
      }
    });
    expect(events[1]).toMatchObject({
      endpoint: "yaya",
      event: "codex_cli_finished",
      metadata: {
        attempt: "resume",
        exitCode: 0,
        stdout,
        stderr: ""
      }
    });
  });

  it("logs resume and fresh Codex CLI attempts", async () => {
    const home = tempHome();
    const workspace = tempHome();
    const stdout = JSON.stringify({ type: "final", final_response: "fresh done" });

    mockExeca()
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "missing session",
        exitCode: 1
      } as never)
      .mockResolvedValueOnce({
        stdout,
        stderr: "",
        exitCode: 0
      } as never);

    const result = await runCodex({ home, runtime: runtimeConfig }, home, workspace, endpoint, "hello");
    const events = readActivityEvents(home);

    expect(result).toMatchObject({
      response: "fresh done",
      exitCode: 0,
      resumed: false
    });
    expect(events.map((event) => [event.event, event.metadata?.attempt])).toEqual([
      ["codex_cli_started", "resume"],
      ["codex_cli_finished", "resume"],
      ["codex_cli_started", "fresh"],
      ["codex_cli_finished", "fresh"]
    ]);
    expect(events[1]?.metadata).toMatchObject({
      exitCode: 1,
      stderr: "missing session"
    });
    expect(events[3]?.metadata).toMatchObject({
      exitCode: 0,
      stdout
    });
  });

  it("logs Codex CLI spawn failures", async () => {
    const home = tempHome();
    const workspace = tempHome();

    mockExeca().mockRejectedValueOnce(new Error("spawn codex ENOENT"));

    await expect(runCodex({ home, runtime: runtimeConfig }, home, workspace, endpoint, "hello")).rejects.toThrow(
      "spawn codex ENOENT"
    );

    expect(readActivityEvents(home).map((event) => [event.event, event.metadata?.attempt, event.metadata?.error])).toEqual([
      ["codex_cli_started", "resume", undefined],
      ["codex_cli_failed", "resume", "spawn codex ENOENT"]
    ]);
  });
});

const cleanupPaths: string[] = [];

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-codex-"));
  cleanupPaths.push(target);
  return target;
}

function mockExeca(): {
  mockResolvedValueOnce(value: unknown): ReturnType<typeof mockExeca>;
  mockRejectedValueOnce(value: unknown): ReturnType<typeof mockExeca>;
} {
  return execa as unknown as ReturnType<typeof mockExeca>;
}

function readActivityEvents(home: string): Array<{
  endpoint: string;
  event: string;
  metadata?: Record<string, unknown>;
}> {
  const content = fs.readFileSync(path.join(logsDir(home), ACTIVITY_LOG_FILE), "utf8");
  return content.trim().split(/\r?\n/).map((line) => JSON.parse(line));
}
