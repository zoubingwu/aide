import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
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

  it("loads MCP tool servers through a generated Pi extension", async () => {
    const home = tempHome();
    const workspace = tempHome();
    const toolServers = [{ name: "aide-discord-context", url: "http://127.0.0.1:43210/mcp" }];
    const stdout = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop"
      }
    });

    mockExeca().mockResolvedValueOnce({
      stdout,
      stderr: "",
      exitCode: 0
    } as never);

    await runPi(home, workspace, endpoint, "hello", { toolServers });

    const extensionPath = path.join(home, "state", "pi-mcp-tools.mjs");
    const [, args, options] = vi.mocked(execa).mock.calls[0] as unknown as [string, string[], Record<string, unknown>];

    expect(args.slice(args.indexOf("--extension"), args.indexOf("--extension") + 2)).toEqual([
      "--extension",
      extensionPath
    ]);
    expect(args.slice(-2)).toEqual(["--continue", "hello"]);
    expect(options).toMatchObject({
      cwd: workspace,
      env: {
        AIDE_PI_TOOL_SERVERS: JSON.stringify(toolServers)
      }
    });
    expect(fs.readFileSync(extensionPath, "utf8")).toContain("notifications/initialized");
  });

  it("registers generated Pi MCP extension tools", async () => {
    const home = tempHome();
    const workspace = tempHome();
    const requests: Array<{
      method: string | undefined;
      session: string | undefined;
      protocol: string | undefined;
    }> = [];
    let initialized = false;
    const server = http.createServer(async (req, res) => {
      const body = JSON.parse(await requestBody(req)) as { method?: string; id?: unknown; params?: Record<string, unknown> };
      const session = req.headers["mcp-session-id"];
      const protocol = req.headers["mcp-protocol-version"];
      requests.push({
        method: body.method,
        session: typeof session === "string" ? session : undefined,
        protocol: typeof protocol === "string" ? protocol : undefined
      });

      if (body.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-1" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-mcp", version: "1.0.0" }
          }
        }));
        return;
      }

      if (body.method === "notifications/initialized") {
        initialized = session === "session-1";
        res.writeHead(202);
        res.end();
        return;
      }

      if (!initialized || session !== "session-1") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32000, message: "MCP session is not initialized." }
        }));
        return;
      }

      const result = body.method === "tools/list"
        ? {
          tools: [{
            name: "discord_get_recent_messages",
            description: "Read recent Discord messages.",
            inputSchema: { type: "object", properties: { source: { type: "string" } }, required: ["source"] }
          }]
        }
        : { content: [{ type: "text", text: `called ${String(body.params?.name)}` }] };

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
    await listen(server);
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("MCP test server did not bind to a TCP port.");
    }

    const toolServers = [{ name: "aide-discord-context", url: `http://127.0.0.1:${address.port}/mcp` }];
    const previousToolServers = process.env.AIDE_PI_TOOL_SERVERS;

    try {
      mockExeca().mockResolvedValueOnce({
        stdout: JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }
        }),
        stderr: "",
        exitCode: 0
      } as never);

      await runPi(home, workspace, endpoint, "hello", { toolServers });
      process.env.AIDE_PI_TOOL_SERVERS = JSON.stringify(toolServers);

      const extensionPath = path.join(home, "state", "pi-mcp-tools.mjs");
      const extension = await import(`${pathToFileURL(extensionPath).href}?test=${Date.now()}`);
      const registeredTools: Array<{ name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }> = [];

      await extension.default({
        registerTool(tool: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) {
          registeredTools.push(tool);
        }
      });

      expect(registeredTools.map((tool) => tool.name)).toEqual(["discord_get_recent_messages"]);
      expect(requests).toEqual([
        { method: "initialize", session: undefined, protocol: "2025-11-25" },
        { method: "notifications/initialized", session: "session-1", protocol: "2025-11-25" },
        { method: "tools/list", session: "session-1", protocol: "2025-11-25" }
      ]);
      await expect(registeredTools[0]?.execute("call-1", { source: "channel:123" })).resolves.toMatchObject({
        content: [{ type: "text", text: "called discord_get_recent_messages" }]
      });
      expect(requests.at(-1)).toEqual({
        method: "tools/call",
        session: "session-1",
        protocol: "2025-11-25"
      });
    } finally {
      if (previousToolServers === undefined) {
        delete process.env.AIDE_PI_TOOL_SERVERS;
      } else {
        process.env.AIDE_PI_TOOL_SERVERS = previousToolServers;
      }

      await closeServer(server);
    }
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

async function requestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
