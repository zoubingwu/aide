import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { execa } from "execa";
import { defaultCodexFreshArgs, defaultCodexResumeArgs } from "./codex-args.js";
import { appendActivityLog, endpointActivity } from "./logging.js";
import { deferredRestartEnv } from "./runtime-restart.js";
import type { AgentRunOptions, AgentToolServer } from "./agent-tools.js";
import type { AgentRunResult, AgentUsage, CodexAgentConfig, Endpoint } from "./types.js";

export function buildCodexArgs(
  agent: CodexAgentConfig,
  workspace: string,
  prompt: string,
  toolServers: AgentToolServer[] = []
): string[] {
  return withCodexAgentConfig(
    ["exec", ...codexMcpConfigArgs(toolServers), "--cd", workspace, ...defaultCodexResumeArgs().slice(1), prompt],
    agent
  );
}

export function buildFreshCodexArgs(
  agent: CodexAgentConfig,
  workspace: string,
  prompt: string,
  toolServers: AgentToolServer[] = []
): string[] {
  return withCodexAgentConfig(
    ["exec", ...codexMcpConfigArgs(toolServers), "--cd", workspace, ...defaultCodexFreshArgs().slice(1), prompt],
    agent
  );
}

function withCodexAgentConfig(args: string[], agent: CodexAgentConfig): string[] {
  const codexConfigArgs = [
    "--model",
    agent.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(agent.reasoningEffort)}`
  ];

  if (args[0] === "exec") {
    return ["exec", ...codexConfigArgs, ...args.slice(1)];
  }

  return [...codexConfigArgs, ...args];
}

function codexMcpConfigArgs(toolServers: AgentToolServer[] = []): string[] {
  return toolServers.flatMap((server) => [
    "-c",
    `mcp_servers.${server.name}.url=${JSON.stringify(server.url)}`
  ]);
}

export async function runCodex(
  home: string,
  workspace: string,
  endpoint: Endpoint,
  prompt: string,
  options: AgentRunOptions = {}
): Promise<AgentRunResult> {
  const agent = endpoint.agent;
  const resumed = await runCodexOnce({
    home,
    endpoint,
    command: agent.command,
    args: buildCodexArgs(agent, workspace, prompt, options.toolServers),
    workspace,
    prompt,
    attempt: "resume",
    onEvent: options.onEvent,
    abortSignal: options.abortSignal
  });

  if (resumed.cancelled) {
    return {
      ...resumed,
      response: "",
      hasTextResponse: false,
      resumed: true
    };
  }

  if (resumed.exitCode === 0) {
    const response = extractFinalResponse(resumed.stdout, resumed.stderr);
    const usage = extractCodexUsage(resumed.stdout, prompt);

    return {
      ...resumed,
      ...response,
      usage,
      usageTokens: usage?.totalTokens,
      resumed: true
    };
  }

  if (options.abortSignal?.aborted) {
    return {
      ...resumed,
      exitCode: 130,
      cancelled: true,
      response: "",
      hasTextResponse: false,
      resumed: true
    };
  }

  const fresh = await runCodexOnce({
    home,
    endpoint,
    command: agent.command,
    args: buildFreshCodexArgs(agent, workspace, prompt, options.toolServers),
    workspace,
    prompt,
    attempt: "fresh",
    onEvent: options.onEvent,
    abortSignal: options.abortSignal
  });

  if (fresh.cancelled) {
    return {
      ...fresh,
      response: "",
      hasTextResponse: false,
      resumed: false
    };
  }

  const response = extractFinalResponse(fresh.stdout, fresh.stderr);
  const usage = extractCodexUsage(fresh.stdout, prompt);

  return {
    ...fresh,
    ...response,
    usage,
    usageTokens: usage?.totalTokens,
    resumed: false
  };
}

export interface ExtractedCodexResponse {
  response: string;
  hasTextResponse: boolean;
}

export function extractFinalResponse(stdout: string, stderr = ""): ExtractedCodexResponse {
  const candidates: string[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    const parsed = parseJsonLine(trimmed);

    if (!parsed) {
      candidates.push(trimmed);
      continue;
    }

    const extracted = extractCodexResponseCandidate(parsed);

    if (extracted) {
      candidates.push(extracted);
    }
  }

  const final = candidates.at(-1)?.trim();

  if (final) {
    return { response: final, hasTextResponse: true };
  }

  const error = stderr.trim();
  return { response: error, hasTextResponse: false };
}

export function extractCodexUsageTokens(stdout: string): number | undefined {
  return extractCodexUsage(stdout)?.totalTokens;
}

export function extractCodexUsage(stdout: string, prompt?: string): AgentUsage | undefined {
  let threadId: string | undefined;
  let stdoutUsage: Record<string, unknown> | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const payload = parseJsonObjectLine(line);

    if (payload?.type === "thread.started" && typeof payload.thread_id === "string") {
      threadId = payload.thread_id;
      continue;
    }

    if (payload?.type === "turn.completed" && isRecord(payload.usage)) {
      stdoutUsage = payload.usage;
    }
  }

  const sessionUsage = threadId ? readCodexSessionUsage(threadId, prompt) : undefined;
  const usage = sessionUsage?.usage ?? codexUsageDetails(stdoutUsage);

  if (!usage) {
    return undefined;
  }

  return {
    ...usage,
    raw: {
      codex: {
        threadId,
        stdoutUsage,
        sessionStartTokenCount: sessionUsage?.startRaw,
        sessionTokenCount: sessionUsage?.raw
      }
    }
  };
}

interface CodexExecution {
  home: string;
  endpoint: Endpoint;
  command: string;
  args: string[];
  workspace: string;
  prompt: string;
  attempt: "resume" | "fresh";
  onEvent?: AgentRunOptions["onEvent"] | undefined;
  abortSignal?: AbortSignal | undefined;
}

type CodexProcessResult = Omit<AgentRunResult, "response" | "hasTextResponse" | "resumed">;

interface CodexEventQueue {
  current: Promise<void>;
}

async function runCodexOnce(execution: CodexExecution): Promise<CodexProcessResult> {
  appendActivityLog(
    execution.home,
    endpointActivity(execution.home, execution.endpoint, "codex_cli_started", {
      attempt: execution.attempt,
      command: execution.command,
      args: sanitizeArgs(execution.args, execution.prompt),
      workspace: execution.workspace
    })
  );

  let runResult: CodexProcessResult;
  const eventQueue: CodexEventQueue = { current: Promise.resolve() };
  const stream = createCodexEventStream(execution, eventQueue);
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
    const subprocessOptions = {
      cwd: execution.workspace,
      reject: false,
      all: false,
      env: deferredRestartEnv(execution.home)
    };
    const subprocess = execution.abortSignal
      ? execa(execution.command, execution.args, {
          ...subprocessOptions,
          cancelSignal: execution.abortSignal
        })
      : execa(execution.command, execution.args, subprocessOptions);

    const stdout = readableStdout(subprocess);

    if (stdout) {
      stdout.on("data", (chunk) => {
        streamedStdout = true;
        stream.write(decodeStdoutChunk(decoder, chunk));
      });
      stdout.on("end", endStream);
    }

    const result = await subprocess;
    const cancelled = Boolean(result.isCanceled || execution.abortSignal?.aborted);
    runResult = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? (cancelled ? 130 : 1),
      cancelled
    };
  } catch (error) {
    if (isCancelledExecution(error) || execution.abortSignal?.aborted) {
      runResult = {
        stdout: stringField(error, "stdout"),
        stderr: stringField(error, "stderr"),
        exitCode: 130,
        cancelled: true
      };
    } else {
      appendActivityLog(
        execution.home,
        endpointActivity(execution.home, execution.endpoint, "codex_cli_failed", {
          attempt: execution.attempt,
          error: errorMessage(error)
        })
      );
      throw error;
    }
  }

  if (streamedStdout) {
    endStream();
  } else {
    appendCodexJsonEvents(execution, runResult.stdout, eventQueue);
  }

  await eventQueue.current;

  appendActivityLog(
    execution.home,
    endpointActivity(execution.home, execution.endpoint, "codex_cli_finished", {
      attempt: execution.attempt,
      exitCode: runResult.exitCode,
      stdout: runResult.stdout,
      stderr: runResult.stderr
    })
  );

  return runResult;
}

function appendCodexJsonEvents(execution: CodexExecution, stdout: string, eventQueue: CodexEventQueue): void {
  for (const line of stdout.split(/\r?\n/)) {
    const payload = parseJsonObjectLine(line);

    if (!payload) {
      continue;
    }

    appendCodexJsonEvent(execution, payload, eventQueue);
  }
}

function createCodexEventStream(
  execution: CodexExecution,
  eventQueue: CodexEventQueue
): { write(chunk: string): void; end(): void } {
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
          appendCodexJsonEvent(execution, payload, eventQueue);
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
        appendCodexJsonEvent(execution, payload, eventQueue);
      }
    }
  };
}

function appendCodexJsonEvent(
  execution: CodexExecution,
  payload: Record<string, unknown>,
  eventQueue: CodexEventQueue
): void {
  const type = typeof payload.type === "string" ? payload.type : undefined;

  appendActivityLog(
    execution.home,
    endpointActivity(execution.home, execution.endpoint, "codex_cli_event", {
      attempt: execution.attempt,
      type,
      payload
    })
  );

  const onEvent = execution.onEvent;

  if (!onEvent) {
    return;
  }

  eventQueue.current = eventQueue.current
    .catch(() => undefined)
    .then(() => onEvent({ attempt: execution.attempt, type, payload }))
    .catch((error) => {
      appendActivityLog(
        execution.home,
        endpointActivity(execution.home, execution.endpoint, "codex_progress_delivery_failed", {
          attempt: execution.attempt,
          type,
          error: errorMessage(error)
        })
      );
    })
    .catch(() => undefined);
}

function readableStdout(value: unknown): NodeJS.ReadableStream | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const stdout = value.stdout;

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

function sanitizeArgs(args: string[], prompt: string): string[] {
  return args.map((arg) => (arg === prompt ? "{prompt}" : arg));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCancelledExecution(error: unknown): boolean {
  return isRecord(error) && error.isCanceled === true;
}

function stringField(value: unknown, key: string): string {
  if (!isRecord(value)) {
    return "";
  }

  const field = value[key];
  return typeof field === "string" ? field : "";
}

function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function parseJsonObjectLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  const parsed = parseJsonLine(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  return parsed as Record<string, unknown>;
}

function extractCodexResponseCandidate(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  if (record.type === "item.completed") {
    return extractAgentMessage(record.item);
  }

  if (record.type === "final" || record.final_response !== undefined || record.finalResponse !== undefined) {
    return extractStringCandidate(record);
  }

  return undefined;
}

function extractAgentMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  if (record.type !== "agent_message") {
    return undefined;
  }

  return stringifyContent(record.text) ?? stringifyContent(record.content) ?? stringifyContent(record.output);
}

interface CodexSessionUsage {
  usage: AgentUsage;
  raw: Record<string, unknown>;
  startRaw?: Record<string, unknown> | undefined;
}

function readCodexSessionUsage(threadId: string, prompt?: string): CodexSessionUsage | undefined {
  const filePath = findCodexSessionFile(threadId);

  if (!filePath) {
    return undefined;
  }

  let tokenCountInfo: Record<string, unknown> | undefined;
  let matchedStartUsage: AgentUsage | undefined;
  let matchedStartTokenCountInfo: Record<string, unknown> | undefined;
  let matchedTokenCountInfo: Record<string, unknown> | undefined;
  let inMatchedTurn = false;

  let content: string;

  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }

  for (const line of content.split(/\r?\n/)) {
    const payload = parseJsonObjectLine(line)?.payload;

    if (!isRecord(payload)) {
      continue;
    }

    if (prompt && isCodexSessionUserMessage(payload, prompt)) {
      inMatchedTurn = true;
      matchedStartUsage = codexTotalUsageDetails(tokenCountInfo);
      matchedStartTokenCountInfo = tokenCountInfo;
      matchedTokenCountInfo = undefined;
      continue;
    }

    if (payload.type === "task_complete") {
      inMatchedTurn = false;
    }

    if (payload.type !== "token_count" || !isRecord(payload.info)) {
      continue;
    }

    tokenCountInfo = payload.info;

    if (inMatchedTurn) {
      matchedTokenCountInfo = payload.info;
    }
  }

  tokenCountInfo = matchedTokenCountInfo ?? tokenCountInfo;

  if (!tokenCountInfo) {
    return undefined;
  }

  const usage =
    usageDelta(matchedStartUsage, codexTotalUsageDetails(matchedTokenCountInfo)) ??
    (isRecord(tokenCountInfo.last_token_usage) ? codexUsageDetails(tokenCountInfo.last_token_usage) : undefined);

  if (!usage) {
    return undefined;
  }

  return { usage, raw: tokenCountInfo, startRaw: matchedStartTokenCountInfo };
}

function isCodexSessionUserMessage(payload: Record<string, unknown>, prompt: string): boolean {
  if (payload.type === "user_message" && payload.message === prompt) {
    return true;
  }

  if (payload.type !== "message" || payload.role !== "user") {
    return false;
  }

  const content = payload.content;

  return Array.isArray(content) && content.some((item) => isRecord(item) && item.type === "input_text" && item.text === prompt);
}

function findCodexSessionFile(threadId: string): string | undefined {
  const sessionsDir = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions");
  const suffix = `${threadId}.jsonl`;
  const pending = [sessionsDir];

  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(suffix)) {
        return entryPath;
      }
    }
  }

  return undefined;
}

function codexUsageDetails(value: unknown): AgentUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputTokens = tokenCount(value.input_tokens);
  const outputTokens = tokenCount(value.output_tokens);

  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: tokenCount(value.total_tokens) ?? (inputTokens ?? 0) + (outputTokens ?? 0),
    cachedInputTokens: tokenCount(value.cached_input_tokens),
    reasoningOutputTokens: tokenCount(value.reasoning_output_tokens)
  };
}

function codexTotalUsageDetails(tokenCountInfo: unknown): AgentUsage | undefined {
  return isRecord(tokenCountInfo) ? codexUsageDetails(tokenCountInfo.total_token_usage) : undefined;
}

function usageDelta(start: AgentUsage | undefined, end: AgentUsage | undefined): AgentUsage | undefined {
  if (!end) {
    return undefined;
  }

  const inputTokens = tokenDelta(start?.inputTokens, end.inputTokens);
  const outputTokens = tokenDelta(start?.outputTokens, end.outputTokens);

  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: tokenDelta(start?.totalTokens, end.totalTokens) ?? inputTokens + outputTokens,
    cachedInputTokens: tokenDelta(start?.cachedInputTokens, end.cachedInputTokens),
    reasoningOutputTokens: tokenDelta(start?.reasoningOutputTokens, end.reasoningOutputTokens)
  };
}

function tokenDelta(start: number | undefined, end: number | undefined): number | undefined {
  if (end === undefined) {
    return undefined;
  }

  const value = end - (start ?? 0);
  return value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function extractStringCandidate(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const directKeys = ["final_response", "finalResponse", "lastMessage", "message", "text", "content", "output", "delta"];

  for (const key of directKeys) {
    const extracted = stringifyContent(record[key]);

    if (extracted) {
      return extracted;
    }
  }

  const nestedMessage = extractStringCandidate(record["message"]);

  if (nestedMessage) {
    return nestedMessage;
  }

  const nestedItem = extractStringCandidate(record["item"]);

  if (nestedItem) {
    return nestedItem;
  }

  return undefined;
}

function stringifyContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const parts = value.map((item) => stringifyContent(item)).filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("") : undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  for (const key of ["text", "content", "output"]) {
    const extracted = stringifyContent(record[key]);

    if (extracted) {
      return extracted;
    }
  }

  return undefined;
}
