import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { execa } from "execa";
import { appendActivityLog, endpointActivity } from "./logging.js";
import { stateDir } from "./paths.js";
import { deferredRestartEnv } from "./runtime-restart.js";
import type { AgentRunOptions, AgentToolServer } from "./agent-tools.js";
import type { AgentRunResult, AgentUsage, Endpoint, PiAgentConfig } from "./types.js";

type PiAttempt = "resume" | "fresh";
type PiProcessResult = Omit<AgentRunResult, "response" | "hasTextResponse" | "resumed">;

const PI_TOOL_SERVERS_ENV = "AIDE_PI_TOOL_SERVERS";
const PI_MCP_EXTENSION_FILE = "pi-mcp-tools.mjs";

interface PiEventQueue {
  current: Promise<void>;
}

export function buildPiArgs(agent: PiAgentConfig, prompt: string, toolServerExtension?: string): string[] {
  return [...piConfigArgs(agent), ...piToolServerExtensionArgs(toolServerExtension), "--continue", prompt];
}

export function buildFreshPiArgs(agent: PiAgentConfig, prompt: string, toolServerExtension?: string): string[] {
  return [...piConfigArgs(agent), ...piToolServerExtensionArgs(toolServerExtension), prompt];
}

export async function runPi(
  home: string,
  workspace: string,
  endpoint: Endpoint,
  prompt: string,
  options: AgentRunOptions = {}
): Promise<AgentRunResult> {
  const agent = piAgent(endpoint);

  if (options.runMode === "fresh") {
    return runPiAttempt({ home, workspace, endpoint, agent, prompt, options, attempt: "fresh" });
  }

  const resumed = await runPiAttempt({ home, workspace, endpoint, agent, prompt, options, attempt: "resume" });

  if (resumed.exitCode === 0 || resumed.cancelled || options.abortSignal?.aborted) {
    return resumed;
  }

  return runPiAttempt({ home, workspace, endpoint, agent, prompt, options, attempt: "fresh" });
}

export interface ExtractedPiResponse {
  response: string;
  hasTextResponse: boolean;
}

export function extractPiFinalResponse(stdout: string, stderr = ""): ExtractedPiResponse {
  const candidates = piJsonPayloads(stdout).flatMap((payload) => piResponseCandidates(payload));
  const final = candidates.at(-1)?.trim();

  if (final) {
    return { response: final, hasTextResponse: true };
  }

  return { response: stderr.trim(), hasTextResponse: false };
}

export function extractPiUsage(stdout: string): AgentUsage | undefined {
  const eventUsages: AgentUsage[] = [];
  let agentEndUsage: AgentUsage | undefined;

  for (const payload of piJsonPayloads(stdout)) {
    if (payload.type === "message_end" || payload.type === "turn_end") {
      pushIfPresent(eventUsages, piMessageUsage(payload.message));
    }

    if (payload.type === "agent_end" && Array.isArray(payload.messages)) {
      agentEndUsage = sumUsage(payload.messages.flatMap((message) => {
        const usage = piMessageUsage(message);
        return usage ? [usage] : [];
      }));
    }
  }

  return agentEndUsage ?? sumUsage(eventUsages);
}

interface PiRunContext {
  home: string;
  workspace: string;
  endpoint: Endpoint;
  agent: PiAgentConfig;
  prompt: string;
  options: AgentRunOptions;
  attempt: PiAttempt;
}

async function runPiAttempt(context: PiRunContext): Promise<AgentRunResult> {
  const toolServerConfig = preparePiToolServerConfig(context.home, context.options.toolServers);
  const args = context.attempt === "resume"
    ? buildPiArgs(context.agent, context.prompt, toolServerConfig?.extensionPath)
    : buildFreshPiArgs(context.agent, context.prompt, toolServerConfig?.extensionPath);
  const processResult = await runPiProcess({ ...context, args, toolServerEnv: toolServerConfig?.env });
  const cancelled = processResult.cancelled || context.options.abortSignal?.aborted;

  if (cancelled) {
    return {
      ...processResult,
      exitCode: processResult.exitCode === 0 ? 130 : processResult.exitCode,
      cancelled: true,
      response: "",
      hasTextResponse: false,
      resumed: context.attempt === "resume"
    };
  }

  const response = extractPiFinalResponse(processResult.stdout, processResult.stderr);
  const usage = extractPiUsage(processResult.stdout);

  return {
    ...processResult,
    ...response,
    usage,
    usageTokens: usage?.totalTokens,
    resumed: context.attempt === "resume"
  };
}

async function runPiProcess(context: PiRunContext & { args: string[]; toolServerEnv?: Record<string, string> | undefined }): Promise<PiProcessResult> {
  appendPiLog(context, "pi_cli_started", {
    command: context.agent.command,
    args: context.args.map((arg) => (arg === context.prompt ? "{prompt}" : arg)),
    workspace: context.workspace
  });

  let result: PiProcessResult;
  const eventQueue: PiEventQueue = { current: Promise.resolve() };
  const stream = createPiEventStream(context, eventQueue);
  const decoder = new StringDecoder("utf8");
  let streamedStdout = false;
  let decoderEnded = false;
  const endStream = () => {
    if (decoderEnded) {
      return;
    }

    decoderEnded = true;
    const remaining = decoder.end();

    if (remaining) {
      stream.write(remaining);
    }

    stream.end();
  };

  try {
    const subprocess = execa(context.agent.command, context.args, {
      cwd: context.workspace,
      reject: false,
      all: false,
      stdin: "ignore",
      ...(context.options.abortSignal ? { cancelSignal: context.options.abortSignal } : {}),
      ...piProcessEnv(context)
    });
    const stdout = readableStdout(subprocess);

    if (stdout) {
      stdout.on("data", (chunk) => {
        streamedStdout = true;
        stream.write(decodeStdoutChunk(decoder, chunk));
      });
      stdout.on("end", endStream);
    }

    const execution = await subprocess;
    const cancelled = Boolean(execution.isCanceled || context.options.abortSignal?.aborted);
    result = {
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode ?? (cancelled ? 130 : 1),
      cancelled
    };
  } catch (error) {
    if (isCancelled(error) || context.options.abortSignal?.aborted) {
      result = {
        stdout: stringField(error, "stdout"),
        stderr: stringField(error, "stderr"),
        exitCode: 130,
        cancelled: true
      };
    } else {
      appendPiLog(context, "pi_cli_failed", { error: errorMessage(error) });
      throw error;
    }
  }

  if (streamedStdout) {
    endStream();
  } else {
    appendPiEvents(context, result.stdout, eventQueue);
  }

  await eventQueue.current;

  appendPiLog(context, "pi_cli_finished", {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr
  });

  return result;
}

function appendPiEvents(context: PiRunContext, stdout: string, eventQueue: PiEventQueue): void {
  for (const payload of piJsonPayloads(stdout)) {
    appendPiEvent(context, payload, eventQueue);
  }
}

function createPiEventStream(context: PiRunContext, eventQueue: PiEventQueue): { write(chunk: string): void; end(): void } {
  let buffered = "";
  let ended = false;

  return {
    write(chunk) {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";

      for (const line of lines) {
        const payload = parseJsonObjectLine(line);

        if (payload) {
          appendPiEvent(context, payload, eventQueue);
        }
      }
    },
    end() {
      if (ended) {
        return;
      }

      ended = true;
      const payload = parseJsonObjectLine(buffered);
      buffered = "";

      if (payload) {
        appendPiEvent(context, payload, eventQueue);
      }
    }
  };
}

function appendPiEvent(context: PiRunContext, payload: Record<string, unknown>, eventQueue: PiEventQueue): void {
  const type = typeof payload.type === "string" ? payload.type : undefined;
  appendPiLog(context, "pi_cli_event", { type, payload });

  if (!context.options.onEvent) {
    return;
  }

  eventQueue.current = eventQueue.current
    .catch(() => undefined)
    .then(() => context.options.onEvent?.({ attempt: context.attempt, type, payload }))
    .catch((error) => {
      appendPiLog(context, "pi_progress_delivery_failed", { type, error: errorMessage(error) });
    });
}

function piConfigArgs(agent: PiAgentConfig): string[] {
  return [
    "--mode",
    "json",
    ...(agent.model ? ["--model", agent.model] : []),
    ...(agent.reasoningEffort ? ["--thinking", agent.reasoningEffort] : [])
  ];
}

function piToolServerExtensionArgs(extensionPath: string | undefined): string[] {
  return extensionPath ? ["--extension", extensionPath] : [];
}

function preparePiToolServerConfig(home: string, toolServers: AgentToolServer[] | undefined): { extensionPath: string; env: Record<string, string> } | undefined {
  if (!toolServers?.length) {
    return undefined;
  }

  const directory = stateDir(home);
  const extensionPath = path.join(directory, PI_MCP_EXTENSION_FILE);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(extensionPath, PI_MCP_EXTENSION_SOURCE);

  return {
    extensionPath,
    env: { [PI_TOOL_SERVERS_ENV]: JSON.stringify(toolServers) }
  };
}

function piProcessEnv(context: PiRunContext & { toolServerEnv?: Record<string, string> | undefined }): { env: Record<string, string> } | Record<string, never> {
  const env = {
    ...context.toolServerEnv,
    ...(context.options.deferredRestartId ? deferredRestartEnv(context.home, context.options.deferredRestartId) : {})
  };

  return Object.keys(env).length > 0 ? { env } : {};
}

const PI_MCP_EXTENSION_SOURCE = String.raw`
const TOOL_SERVERS_ENV = "AIDE_PI_TOOL_SERVERS";
const JSON_HEADERS = {
  "accept": "application/json, text/event-stream",
  "content-type": "application/json"
};

export default async function aideMcpTools(pi) {
  const toolServers = parseToolServers(process.env[TOOL_SERVERS_ENV]);
  const registeredNames = new Set();

  for (const server of toolServers) {
    const client = new McpHttpClient(server.url);
    await client.initialize();
    const listed = await client.request("tools/list", {});
    const tools = Array.isArray(listed.tools) ? listed.tools : [];

    for (const tool of tools) {
      if (!tool || typeof tool.name !== "string") {
        continue;
      }

      const toolName = uniqueToolName(tool.name, server.name, registeredNames);
      pi.registerTool({
        name: toolName,
        label: tool.title ?? tool.name,
        description: tool.description ?? "Call a scoped MCP tool.",
        promptSnippet: tool.description ?? "Call a scoped MCP tool.",
        promptGuidelines: ["Use " + toolName + " when the current request needs " + server.name + " context."],
        parameters: schemaObject(tool.inputSchema),
        async execute(_toolCallId, params, signal) {
          const result = await client.request("tools/call", {
            name: tool.name,
            arguments: params
          }, signal);

          return {
            content: toolContent(result),
            details: {
              server: server.name,
              tool: tool.name,
              mcp: result
            }
          };
        }
      });
    }
  }
}

class McpHttpClient {
  constructor(url) {
    this.url = url;
    this.protocolVersion = "2025-11-25";
  }

  async initialize(signal) {
    const result = await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: {
        name: "aide-pi-mcp-tools",
        version: "1.0.0"
      }
    }, signal);

    if (typeof result.protocolVersion === "string") {
      this.protocolVersion = result.protocolVersion;
    }

    await this.notify("notifications/initialized", signal);
  }

  async request(method, params, signal) {
    const id = Date.now() + Math.random();
    const response = await this.post({
      jsonrpc: "2.0",
      id,
      method,
      params
    }, signal);
    const payload = await readMcpResponse(response, id);

    if (payload.error) {
      throw new Error(payload.error.message ?? JSON.stringify(payload.error));
    }

    return payload.result ?? {};
  }

  async notify(method, signal) {
    const response = await this.post({
      jsonrpc: "2.0",
      method
    }, signal);

    if (response.status !== 202) {
      await response.body?.cancel();
    }
  }

  async post(message, signal) {
    const headers = {
      ...JSON_HEADERS,
      "mcp-protocol-version": this.protocolVersion,
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {})
    };
    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal
    });
    const sessionId = response.headers.get("mcp-session-id");

    if (sessionId) {
      this.sessionId = sessionId;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || "MCP request failed with HTTP " + response.status);
    }

    return response;
  }
}

function parseToolServers(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((server) => typeof server?.name === "string" && typeof server?.url === "string")
      : [];
  } catch {
    return [];
  }
}

async function readMcpResponse(response, id) {
  if (response.status === 202) {
    return {};
  }

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("text/event-stream")
    ? readSseJson(await response.text(), id)
    : await response.json();

  return Array.isArray(payload)
    ? payload.find((item) => item?.id === id) ?? {}
    : payload;
}

function readSseJson(text, id) {
  const messages = text
    .split(/\r?\n\r?\n/)
    .flatMap((event) => {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");

      if (!data) {
        return [];
      }

      try {
        return [JSON.parse(data)];
      } catch {
        return [];
      }
    });

  return messages.find((item) => item?.id === id) ?? messages[0] ?? {};
}

function uniqueToolName(name, serverName, registeredNames) {
  if (!registeredNames.has(name)) {
    registeredNames.add(name);
    return name;
  }

  const prefixed = toolNameSegment(serverName) + "_" + name;
  registeredNames.add(prefixed);
  return prefixed;
}

function toolNameSegment(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "mcp";
}

function schemaObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : { type: "object", properties: {}, additionalProperties: true };
}

function toolContent(value) {
  if (Array.isArray(value?.content)) {
    return value.content.flatMap((item) => {
      if (item?.type === "text" && typeof item.text === "string") {
        return [{ type: "text", text: item.text }];
      }

      if (item?.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
        return [{ type: "image", data: item.data, mimeType: item.mimeType }];
      }

      return [{ type: "text", text: JSON.stringify(item) }];
    });
  }

  return [{ type: "text", text: JSON.stringify(value) }];
}
`;

function piResponseCandidates(payload: Record<string, unknown>): string[] {
  if (payload.type === "message_end" || payload.type === "turn_end") {
    const text = piMessageText(payload.message);
    return text === undefined ? [] : [text];
  }

  if (payload.type !== "agent_end" || !Array.isArray(payload.messages)) {
    return [];
  }

  return payload.messages.flatMap((message) => {
    const text = piMessageText(message);
    return text === undefined ? [] : [text];
  });
}

function piMessageText(value: unknown): string | undefined {
  const message = recordValue(value);

  if (!message || message.role !== "assistant") {
    return undefined;
  }

  if (message.stopReason === "error" && typeof message.errorMessage === "string") {
    return message.errorMessage;
  }

  return (Array.isArray(message.content) ? message.content : [])
    .flatMap((item) => {
      const content = recordValue(item);
      return content?.type === "text" && typeof content.text === "string" ? [content.text] : [];
    })
    .join("");
}

function piMessageUsage(value: unknown): AgentUsage | undefined {
  const message = recordValue(value);

  if (!message || message.role !== "assistant") {
    return undefined;
  }

  return piUsageDetails(message.usage);
}

function piUsageDetails(value: unknown): AgentUsage | undefined {
  const usage = recordValue(value);

  if (!usage) {
    return undefined;
  }

  const input = tokenCount(usage.input);
  const output = tokenCount(usage.output);
  const cacheRead = tokenCount(usage.cacheRead);
  const cacheWrite = tokenCount(usage.cacheWrite);

  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return undefined;
  }

  const inputTokens = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);

  return {
    inputTokens,
    outputTokens: output ?? 0,
    totalTokens: tokenCount(usage.totalTokens) ?? inputTokens + (output ?? 0),
    cachedInputTokens: cacheRead,
    reasoningOutputTokens: tokenCount(usage.reasoning),
    raw: { pi: { usage } }
  };
}

function sumUsage(usages: AgentUsage[]): AgentUsage | undefined {
  if (usages.length === 0) {
    return undefined;
  }

  return {
    inputTokens: sum(usages, "inputTokens"),
    outputTokens: sum(usages, "outputTokens"),
    totalTokens: sum(usages, "totalTokens"),
    cachedInputTokens: usages.reduce((total, usage) => total + (usage.cachedInputTokens ?? 0), 0),
    reasoningOutputTokens: usages.reduce((total, usage) => total + (usage.reasoningOutputTokens ?? 0), 0),
    raw: { pi: { usages: usages.map((usage) => usage.raw) } }
  };
}

function appendPiLog(context: PiRunContext, event: string, metadata: Record<string, unknown>): void {
  appendActivityLog(
    context.home,
    endpointActivity(context.home, context.endpoint, event, {
      attempt: context.attempt,
      ...metadata
    })
  );
}

function piAgent(endpoint: Endpoint): PiAgentConfig {
  if (endpoint.agent.provider !== "pi") {
    throw new Error(`Pi runner received ${endpoint.agent.provider} agent config.`);
  }

  return endpoint.agent;
}

function piJsonPayloads(stdout: string): Record<string, unknown>[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const payload = parseJsonObjectLine(line);
    return payload ? [payload] : [];
  });
}

function parseJsonObjectLine(line: string): Record<string, unknown> | undefined {
  try {
    return recordValue(JSON.parse(line.trim()));
  } catch {
    return undefined;
  }
}

function readableStdout(value: unknown): NodeJS.ReadableStream | undefined {
  const stdout = recordValue(value)?.stdout;

  if (!stdout || typeof stdout !== "object" || !("on" in stdout) || typeof stdout.on !== "function") {
    return undefined;
  }

  return stdout as NodeJS.ReadableStream;
}

function decodeStdoutChunk(decoder: StringDecoder, chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }

  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
    return decoder.write(chunk);
  }

  return String(chunk);
}

function pushIfPresent<T>(items: T[], item: T | undefined): void {
  if (item !== undefined) {
    items.push(item);
  }
}

function sum(usages: AgentUsage[], key: "inputTokens" | "outputTokens" | "totalTokens"): number {
  return usages.reduce((total, usage) => total + usage[key], 0);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown, key: string): string {
  const field = recordValue(value)?.[key];
  return typeof field === "string" ? field : "";
}

function isCancelled(error: unknown): boolean {
  return recordValue(error)?.isCanceled === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
