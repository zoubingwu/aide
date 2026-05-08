import { execa } from "execa";
import { defaultCodexFreshArgs, defaultCodexResumeArgs } from "./codex-args.js";
import { appendActivityLog, endpointActivity } from "./logging.js";
import type { AgentRunOptions, AgentToolServer } from "./agent-tools.js";
import type { AgentRunResult, CodexAgentConfig, Endpoint } from "./types.js";

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
    attempt: "resume"
  });

  if (resumed.exitCode === 0) {
    const response = extractFinalResponse(resumed.stdout, resumed.stderr);

    return {
      ...resumed,
      ...response,
      usageTokens: extractCodexUsageTokens(resumed.stdout),
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
    attempt: "fresh"
  });
  const response = extractFinalResponse(fresh.stdout, fresh.stderr);

  return {
    ...fresh,
    ...response,
    usageTokens: extractCodexUsageTokens(fresh.stdout),
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
  let tokens: number | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const payload = parseJsonObjectLine(line);

    if (payload?.type !== "turn.completed") {
      continue;
    }

    const usageTokens = codexUsageTokens(payload.usage);

    if (usageTokens !== undefined) {
      tokens = usageTokens;
    }
  }

  return tokens;
}

interface CodexExecution {
  home: string;
  endpoint: Endpoint;
  command: string;
  args: string[];
  workspace: string;
  prompt: string;
  attempt: "resume" | "fresh";
}

type CodexProcessResult = Omit<AgentRunResult, "response" | "hasTextResponse" | "resumed">;

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

  try {
    const result = await execa(execution.command, execution.args, {
      cwd: execution.workspace,
      reject: false,
      all: false
    });
    runResult = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 1
    };
  } catch (error) {
    appendActivityLog(
      execution.home,
      endpointActivity(execution.home, execution.endpoint, "codex_cli_failed", {
        attempt: execution.attempt,
        error: errorMessage(error)
      })
    );
    throw error;
  }

  appendCodexJsonEvents(execution, runResult.stdout);
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

function appendCodexJsonEvents(execution: CodexExecution, stdout: string): void {
  for (const line of stdout.split(/\r?\n/)) {
    const payload = parseJsonObjectLine(line);

    if (!payload) {
      continue;
    }

    appendActivityLog(
      execution.home,
      endpointActivity(execution.home, execution.endpoint, "codex_cli_event", {
        attempt: execution.attempt,
        type: typeof payload.type === "string" ? payload.type : undefined,
        payload
      })
    );
  }
}

function sanitizeArgs(args: string[], prompt: string): string[] {
  return args.map((arg) => (arg === prompt ? "{prompt}" : arg));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function codexUsageTokens(value: unknown): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const total = tokenCount(record.total_tokens);

  if (total !== undefined) {
    return total;
  }

  const input = tokenCount(record.input_tokens);
  const output = tokenCount(record.output_tokens);

  if (input === undefined && output === undefined) {
    return undefined;
  }

  return (input ?? 0) + (output ?? 0);
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
