import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import {
  buildFreshPiArgs,
  buildPiArgs,
  extractPiFinalResponse,
  extractPiUsage,
  runPi
} from "../src/lib/pi.js";
import { defaultEndpointTriggerConfig } from "../src/lib/config.js";
import { ACTIVITY_LOG_FILE } from "../src/lib/logging.js";
import { logsDir } from "../src/lib/paths.js";
import type { Endpoint, PiAgentConfig } from "../src/lib/types.js";

vi.mock("execa", () => ({
  execa: vi.fn()
}));

const agentConfig: PiAgentConfig = {
  provider: "pi",
  command: "pi",
  model: "sonnet",
  reasoningEffort: "high",
  outputMode: "concise"
};

const endpoint: Endpoint = {
  id: "yaya",
  provider: "discord",
  enabled: true,
  token: "test-token",
  trigger: defaultEndpointTriggerConfig(),
  agent: agentConfig
};

describe("pi", () => {
  afterEach(() => {
    vi.clearAllMocks();

    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("builds resume-last JSON args with configured model and thinking", () => {
    expect(buildPiArgs(agentConfig, "hello")).toEqual([
      "--mode",
      "json",
      "--model",
      "sonnet",
      "--thinking",
      "high",
      "--continue",
      "hello"
    ]);
  });

  it("builds fresh JSON args while preserving Pi defaults", () => {
    expect(buildFreshPiArgs({
      provider: "pi",
      command: "pi",
      outputMode: "concise"
    }, "hello")).toEqual([
      "--mode",
      "json",
      "hello"
    ]);
  });

  it("extracts final assistant text from Pi JSONL output", () => {
    const output = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop"
        }
      })
    ].join("\n");

    expect(extractPiFinalResponse(output)).toEqual({ response: "done", hasTextResponse: true });
  });

  it("extracts aggregate usage from Pi agent end messages", () => {
    const output = JSON.stringify({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
          stopReason: "toolUse",
          usage: {
            input: 10,
            output: 4,
            cacheRead: 3,
            cacheWrite: 2,
            reasoning: 1,
            totalTokens: 19
          }
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
          usage: {
            input: 20,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 2,
            totalTokens: 25
          }
        }
      ]
    });

    expect(extractPiFinalResponse(output)).toEqual({ response: "done", hasTextResponse: true });
    expect(extractPiUsage(output)).toMatchObject({
      inputTokens: 35,
      outputTokens: 9,
      totalTokens: 44,
      cachedInputTokens: 3,
      reasoningOutputTokens: 3
    });
  });

  it("logs Pi JSONL output", async () => {
    const home = tempHome();
    const workspace = tempHome();
    const onEvent = vi.fn();
    const stdout = [
      JSON.stringify({ type: "session", version: 3, id: "session_1", cwd: workspace }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
          usage: {
            input: 10,
            output: 2,
            cacheRead: 1,
            cacheWrite: 0,
            totalTokens: 13
          }
        }
      })
    ].join("\n");

    mockExeca().mockResolvedValueOnce({
      stdout,
      stderr: "",
      exitCode: 0
    } as never);

    const result = await runPi(home, workspace, endpoint, "hello", { onEvent });
    const events = readActivityEvents(home);

    expect(result.response).toBe("done");
    expect(result.hasTextResponse).toBe(true);
    expect(result.usage).toMatchObject({
      inputTokens: 11,
      outputTokens: 2,
      totalTokens: 13,
      cachedInputTokens: 1
    });
    expect(events[0]).toMatchObject({
      endpoint: "yaya",
      event: "pi_cli_started",
      metadata: {
        attempt: "resume",
        command: "pi",
        args: [
          "--mode",
          "json",
          "--model",
          "sonnet",
          "--thinking",
          "high",
          "--continue",
          "{prompt}"
        ],
        workspace
      }
    });
    expect(execa).toHaveBeenCalledWith("pi", expect.arrayContaining(["--mode", "json", "--continue", "hello"]), {
      cwd: workspace,
      reject: false,
      all: false,
      stdin: "ignore"
    });
    expect(events.slice(1, 4).map((event) => [event.event, event.metadata?.type])).toEqual([
      ["pi_cli_event", "session"],
      ["pi_cli_event", "agent_start"],
      ["pi_cli_event", "message_end"]
    ]);
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual([
      "session",
      "agent_start",
      "message_end"
    ]);
  });

  it("streams Pi JSONL events before the process exits", async () => {
    const home = tempHome();
    const workspace = tempHome();
    const stream = new EventEmitter();
    const stdout = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop"
        }
      })
    ].join("\n");
    let resolveProcess: (value: unknown) => void = () => {};
    let resolveFirstEvent: () => void = () => {};
    const firstEvent = new Promise<void>((resolve) => {
      resolveFirstEvent = resolve;
    });
    const subprocess = Object.assign(new Promise((resolve) => {
      resolveProcess = resolve;
    }), { stdout: stream });
    const onEvent = vi.fn((event: { type?: string | undefined }) => {
      if (event.type === "agent_start") {
        resolveFirstEvent();
      }
    });

    mockExeca().mockReturnValueOnce(subprocess as never);

    const result = runPi(home, workspace, endpoint, "hello", { onEvent });
    stream.emit("data", `${JSON.stringify({ type: "agent_start" })}\n`);

    await firstEvent;

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "agent_start" }));

    stream.emit("data", `${JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop"
      }
    })}\n`);
    stream.emit("end");
    resolveProcess({ stdout, stderr: "", exitCode: 0 });

    await expect(result).resolves.toMatchObject({
      response: "done",
      hasTextResponse: true,
      exitCode: 0
    });
  });

  it("falls back to fresh Pi runs after failed resume attempts", async () => {
    const home = tempHome();
    const workspace = tempHome();
    const stdout = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fresh done" }],
        stopReason: "stop"
      }
    });

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

    const result = await runPi(home, workspace, endpoint, "hello");
    const events = readActivityEvents(home);

    expect(result).toMatchObject({
      response: "fresh done",
      hasTextResponse: true,
      exitCode: 0,
      resumed: false
    });
    expect(mockExeca()).toHaveBeenCalledTimes(2);
    expect(events.map((event) => [event.event, event.metadata?.attempt])).toEqual([
      ["pi_cli_started", "resume"],
      ["pi_cli_finished", "resume"],
      ["pi_cli_started", "fresh"],
      ["pi_cli_event", "fresh"],
      ["pi_cli_finished", "fresh"]
    ]);
  });
});

const cleanupPaths: string[] = [];

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-pi-"));
  cleanupPaths.push(target);
  return target;
}

function mockExeca(): {
  mockResolvedValueOnce(value: unknown): ReturnType<typeof mockExeca>;
  mockReturnValueOnce(value: unknown): ReturnType<typeof mockExeca>;
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
