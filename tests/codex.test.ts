import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import {
  buildCodexArgs,
  buildFreshCodexArgs,
  extractCodexUsage,
  extractCodexUsageTokens,
  extractFinalResponse,
  runCodex
} from "../src/lib/codex.js";
import { defaultCodexAgentConfig, defaultEndpointTriggerConfig } from "../src/lib/config.js";
import { defaultCodexFreshArgs, defaultCodexResumeArgs } from "../src/lib/codex-args.js";
import { ACTIVITY_LOG_FILE } from "../src/lib/logging.js";
import { logsDir } from "../src/lib/paths.js";
import type { AgentRunEvent } from "../src/lib/agent-tools.js";
import type { CodexAgentConfig, Endpoint } from "../src/lib/types.js";

vi.mock("execa", () => ({
  execa: vi.fn()
}));

const agentConfig: CodexAgentConfig = {
  ...defaultCodexAgentConfig(),
  model: "gpt-5.5",
  reasoningEffort: "medium"
};

const endpoint: Endpoint = {
  id: "yaya",
  provider: "discord",
  enabled: true,
  token: "test-token",
  trigger: defaultEndpointTriggerConfig(),
  agent: agentConfig
};
const originalCodexHome = process.env.CODEX_HOME;

describe("codex", () => {
  afterEach(() => {
    vi.clearAllMocks();
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }

    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("builds resume-last exec args with prompt at the end", () => {
    const workspace = path.join(os.tmpdir(), "aide-workspace");

    expect(buildCodexArgs(agentConfig, workspace, "hello")).toEqual([
      "exec",
      "--model",
      "gpt-5.5",
      "-c",
      "model_reasoning_effort=\"medium\"",
      "--cd",
      workspace,
      ...defaultCodexResumeArgs().slice(1),
      "hello"
    ]);
  });

  it("builds resume args with MCP tool server config", () => {
    const workspace = path.join(os.tmpdir(), "aide-workspace");

    expect(
      buildCodexArgs(agentConfig, workspace, "hello", [
        { name: "aide-discord-context", url: "http://127.0.0.1:43210/mcp" }
      ])
    ).toEqual([
      "exec",
      "--model",
      "gpt-5.5",
      "-c",
      "model_reasoning_effort=\"medium\"",
      "-c",
      "mcp_servers.aide-discord-context.url=\"http://127.0.0.1:43210/mcp\"",
      "--cd",
      workspace,
      ...defaultCodexResumeArgs().slice(1),
      "hello"
    ]);
  });

  it("builds fresh exec args for first-run fallback", () => {
    const workspace = path.join(os.tmpdir(), "aide-workspace");

    expect(buildFreshCodexArgs(agentConfig, workspace, "hello")).toEqual([
      "exec",
      "--model",
      "gpt-5.5",
      "-c",
      "model_reasoning_effort=\"medium\"",
      "--cd",
      workspace,
      ...defaultCodexFreshArgs().slice(1),
      "hello"
    ]);
  });

  it("extracts final text from JSONL output", () => {
    const output = [
      JSON.stringify({ type: "event", message: "working" }),
      JSON.stringify({ type: "final", final_response: "done" })
    ].join("\n");

    expect(extractFinalResponse(output)).toEqual({ response: "done", hasTextResponse: true });
  });

  it("extracts agent_message text from Codex item events", () => {
    const output = [
      JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "user_message", text: "ignore me" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "done" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } })
    ].join("\n");

    expect(extractFinalResponse(output)).toEqual({ response: "done", hasTextResponse: true });
  });

  it("marks empty Codex agent messages as successful no-response output", () => {
    const output = [
      JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } })
    ].join("\n");

    expect(extractFinalResponse(output)).toEqual({ response: "", hasTextResponse: false });
  });

  it("extracts token usage from Codex turn completion", () => {
    const output = JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 10,
        cached_input_tokens: 4,
        output_tokens: 3,
        reasoning_output_tokens: 2
      }
    });

    expect(extractCodexUsageTokens(output)).toBe(13);
  });

  it("extracts per-turn token usage from Codex session files", () => {
    const codexHome = tempHome();
    const threadId = "019e0dba-5b57-7160-8335-9c1576189633";
    const prompt = "Reply with exactly: AIDE_USAGE_RESUME";
    const sessionDir = path.join(codexHome, "sessions", "2026", "05", "10");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, `rollout-2026-05-10T01-12-57-${threadId}.jsonl`),
      [
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 20172,
                cached_input_tokens: 7552,
                output_tokens: 20,
                reasoning_output_tokens: 9,
                total_tokens: 20192
              },
              last_token_usage: {
                input_tokens: 20172,
                cached_input_tokens: 7552,
                output_tokens: 20,
                reasoning_output_tokens: 9,
                total_tokens: 20192
              }
            }
          }
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: prompt }]
          }
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 30000,
                cached_input_tokens: 17392,
                output_tokens: 24,
                reasoning_output_tokens: 9,
                total_tokens: 30024
              },
              last_token_usage: {
                input_tokens: 9828,
                cached_input_tokens: 9840,
                output_tokens: 4,
                reasoning_output_tokens: 0,
                total_tokens: 9832
              }
            }
          }
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 40379,
                cached_input_tokens: 27392,
                output_tokens: 29,
                reasoning_output_tokens: 9,
                total_tokens: 40408
              },
              last_token_usage: {
                input_tokens: 10379,
                cached_input_tokens: 10000,
                output_tokens: 5,
                reasoning_output_tokens: 0,
                total_tokens: 10384
              }
            }
          }
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "task_complete"
          }
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 999,
                output_tokens: 999,
                total_tokens: 1998
              }
            }
          }
        })
      ].join("\n")
    );
    process.env.CODEX_HOME = codexHome;

    const output = [
      JSON.stringify({ type: "thread.started", thread_id: threadId }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 40379, output_tokens: 29 } })
    ].join("\n");

    expect(extractCodexUsage(output, prompt)).toMatchObject({
      inputTokens: 20207,
      outputTokens: 9,
      totalTokens: 20216,
      cachedInputTokens: 19840,
      reasoningOutputTokens: 0,
      raw: {
        codex: {
          threadId,
          stdoutUsage: { input_tokens: 40379, output_tokens: 29 },
          sessionStartTokenCount: {
            total_token_usage: {
              total_tokens: 20192
            }
          },
          sessionTokenCount: {
            last_token_usage: {
              total_tokens: 10384
            },
            total_token_usage: {
              total_tokens: 40408
            }
          }
        }
      }
    });
  });

  it("uses stderr when stdout has no text", () => {
    expect(extractFinalResponse("", "missing session")).toEqual({ response: "missing session", hasTextResponse: false });
  });

  it("logs Codex CLI JSONL output", async () => {
    const home = tempHome();
    const workspace = tempHome();
    const onEvent = vi.fn();
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "done" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } })
    ].join("\n");

    mockExeca().mockResolvedValueOnce({
      stdout,
      stderr: "",
      exitCode: 0
    } as never);

    const result = await runCodex(home, workspace, endpoint, "hello", { onEvent });
    const events = readActivityEvents(home);

    expect(result.response).toBe("done");
    expect(result.hasTextResponse).toBe(true);
    expect(result.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12
    });
    expect(result.usageTokens).toBe(12);
    expect(events).toHaveLength(6);
    expect(events[0]).toMatchObject({
      endpoint: "yaya",
      event: "codex_cli_started",
      metadata: {
        attempt: "resume",
        command: "codex",
        args: [
          "exec",
          "--model",
          "gpt-5.5",
          "-c",
          "model_reasoning_effort=\"medium\"",
          "--cd",
          workspace,
          ...defaultCodexResumeArgs().slice(1),
          "{prompt}"
        ],
        workspace
      }
    });
    expect(execa).toHaveBeenCalledWith("codex", expect.arrayContaining(["--cd", workspace]), {
      cwd: workspace,
      reject: false,
      all: false
    });
    expect(events.slice(1, 5).map((event) => [event.event, event.metadata?.type])).toEqual([
      ["codex_cli_event", "thread.started"],
      ["codex_cli_event", "turn.started"],
      ["codex_cli_event", "item.completed"],
      ["codex_cli_event", "turn.completed"]
    ]);
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "thread.started",
      "turn.started",
      "item.completed",
      "turn.completed"
    ]);
    expect(events[3]?.metadata?.payload).toMatchObject({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: "done"
      }
    });
    expect(events[5]).toMatchObject({
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

  it("delivers Codex JSONL events in output order", async () => {
    const home = tempHome();
    const workspace = tempHome();
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_1" }),
      JSON.stringify({ type: "item.started", item: { id: "item_0", type: "tool_call" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "done" } })
    ].join("\n");
    const seen: Array<string | undefined> = [];
    let releaseFirstEvent: () => void = () => {};
    let markFirstEventStarted: () => void = () => {};
    const firstEventStarted = new Promise<void>((resolve) => {
      markFirstEventStarted = resolve;
    });
    const firstEventBlocked = new Promise<void>((resolve) => {
      releaseFirstEvent = resolve;
    });
    const onEvent = vi.fn(async (event: AgentRunEvent) => {
      seen.push(event.type);

      if (seen.length === 1) {
        markFirstEventStarted();
        await firstEventBlocked;
      }
    });

    mockExeca().mockResolvedValueOnce({
      stdout,
      stderr: "",
      exitCode: 0
    } as never);

    const result = runCodex(home, workspace, endpoint, "hello", { onEvent });

    await firstEventStarted;
    await Promise.resolve();

    expect(seen).toEqual(["thread.started"]);

    releaseFirstEvent();
    await expect(result).resolves.toMatchObject({
      response: "done",
      hasTextResponse: true,
      exitCode: 0
    });
    expect(seen).toEqual(["thread.started", "item.started", "item.completed"]);
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

    const result = await runCodex(home, workspace, endpoint, "hello");
    const events = readActivityEvents(home);

    expect(result).toMatchObject({
      response: "fresh done",
      hasTextResponse: true,
      exitCode: 0,
      resumed: false,
      usageTokens: undefined
    });
    expect(events.map((event) => [event.event, event.metadata?.attempt])).toEqual([
      ["codex_cli_started", "resume"],
      ["codex_cli_finished", "resume"],
      ["codex_cli_started", "fresh"],
      ["codex_cli_event", "fresh"],
      ["codex_cli_finished", "fresh"]
    ]);
    expect(events[1]?.metadata).toMatchObject({
      exitCode: 1,
      stderr: "missing session"
    });
    expect(events[3]?.metadata).toMatchObject({
      type: "final",
      payload: {
        final_response: "fresh done"
      }
    });
    expect(events[4]?.metadata).toMatchObject({
      exitCode: 0,
      stdout
    });
  });

  it("logs Codex CLI spawn failures", async () => {
    const home = tempHome();
    const workspace = tempHome();

    mockExeca().mockRejectedValueOnce(new Error("spawn codex ENOENT"));

    await expect(runCodex(home, workspace, endpoint, "hello")).rejects.toThrow(
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
