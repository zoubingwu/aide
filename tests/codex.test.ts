import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  buildFreshCodexArgs,
  extractFinalResponse
} from "../src/lib/codex.js";

describe("codex", () => {
  it("builds resume-last exec args with prompt at the end", () => {
    expect(buildCodexArgs(["exec", "resume", "--last", "--json", "--skip-git-repo-check"], "hello")).toEqual([
      "exec",
      "resume",
      "--last",
      "--json",
      "--skip-git-repo-check",
      "hello"
    ]);
  });

  it("builds fresh exec args for first-run fallback", () => {
    expect(buildFreshCodexArgs("hello")).toEqual(["exec", "--json", "--skip-git-repo-check", "hello"]);
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
