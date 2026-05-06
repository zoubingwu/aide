import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  buildFreshCodexArgs,
  extractFinalResponse
} from "../src/lib/codex.js";
import type { RuntimeConfig } from "../src/lib/types.js";

const runtimeConfig: RuntimeConfig = {
  provider: "codex",
  command: "codex",
  args: ["exec", "resume", "--last", "--json", "--skip-git-repo-check"],
  model: "gpt-5.5",
  reasoningEffort: "medium",
  startupTimeoutMs: 30_000
};

describe("codex", () => {
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
});
