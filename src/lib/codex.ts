import { execa } from "execa";
import type { AgentRunResult, AideConfig, Endpoint, RuntimeConfig } from "./types.js";

const DEFAULT_RESUME_ARGS = ["exec", "resume", "--last", "--json", "--skip-git-repo-check"];

export function buildCodexArgs(runtime: RuntimeConfig, prompt: string): string[] {
  const runtimeArgs = runtime.args.length > 0 ? runtime.args : DEFAULT_RESUME_ARGS;
  return withCodexRuntimeConfig(buildPromptArgs(runtimeArgs, prompt), runtime);
}

export function buildFreshCodexArgs(runtime: RuntimeConfig, prompt: string): string[] {
  return withCodexRuntimeConfig(["exec", "--json", "--skip-git-repo-check", prompt], runtime);
}

function buildPromptArgs(runtimeArgs: string[], prompt: string): string[] {
  const promptIndex = runtimeArgs.indexOf("{prompt}");

  if (promptIndex !== -1) {
    const result = [...runtimeArgs];
    result[promptIndex] = prompt;
    return result;
  }

  if (runtimeArgs[0] === "exec" && runtimeArgs[1] === "resume") {
    return [...runtimeArgs, prompt];
  }

  if (runtimeArgs[0] === "exec") {
    return ["exec", prompt, ...runtimeArgs.slice(1)];
  }

  return [...runtimeArgs, prompt];
}

function withCodexRuntimeConfig(args: string[], runtime: RuntimeConfig): string[] {
  const codexConfigArgs = [
    "--model",
    runtime.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(runtime.reasoningEffort)}`
  ];

  if (args[0] === "exec") {
    return ["exec", ...codexConfigArgs, ...args.slice(1)];
  }

  return [...codexConfigArgs, ...args];
}

export async function runCodex(
  config: AideConfig,
  workspace: string,
  endpoint: Endpoint,
  prompt: string
): Promise<AgentRunResult> {
  const resumed = await runCodexOnce(config.runtime.command, buildCodexArgs(config.runtime, prompt), workspace);

  if (resumed.exitCode === 0) {
    return {
      ...resumed,
      response: extractFinalResponse(resumed.stdout, resumed.stderr),
      resumed: true
    };
  }

  const fresh = await runCodexOnce(config.runtime.command, buildFreshCodexArgs(config.runtime, prompt), workspace);

  return {
    ...fresh,
    response: extractFinalResponse(fresh.stdout, fresh.stderr),
    resumed: false
  };
}

export function extractFinalResponse(stdout: string, stderr = ""): string {
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

    const extracted = extractStringCandidate(parsed);

    if (extracted) {
      candidates.push(extracted);
    }
  }

  const final = candidates.at(-1)?.trim();

  if (final) {
    return final;
  }

  const error = stderr.trim();
  return error.length > 0 ? error : "Codex finished without a text response.";
}

async function runCodexOnce(command: string, args: string[], cwd: string): Promise<Omit<AgentRunResult, "response" | "resumed">> {
  const result = await execa(command, args, {
    cwd,
    reject: false,
    all: false,
    env: {
      ...process.env,
      AIDE_ENDPOINT_WORKSPACE: cwd
    }
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1
  };
}

function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
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
