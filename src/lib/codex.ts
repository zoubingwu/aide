import { execa } from "execa";
import type { AideConfig, Endpoint } from "./types.js";

export interface CodexRunResult {
  response: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  resumed: boolean;
}

export function buildCodexArgs(runtimeArgs: string[], prompt: string): string[] {
  const args = runtimeArgs.length > 0 ? runtimeArgs : ["exec", "resume", "--last", "--json", "--skip-git-repo-check"];
  const promptIndex = args.indexOf("{prompt}");

  if (promptIndex !== -1) {
    const result = [...args];
    result[promptIndex] = prompt;
    return result;
  }

  if (args[0] === "exec" && args[1] === "resume") {
    return [...args, prompt];
  }

  if (args[0] === "exec") {
    return ["exec", prompt, ...args.slice(1)];
  }

  return [...args, prompt];
}

export function buildFreshCodexArgs(prompt: string): string[] {
  return ["exec", "--json", "--skip-git-repo-check", prompt];
}

export function makeAssistantPrompt(endpoint: Endpoint, message: string, author: string): string {
  return `Endpoint: ${endpoint.id}
Provider: ${endpoint.provider}
Author: ${author}

${message}`;
}

export async function runCodex(
  config: AideConfig,
  workspace: string,
  endpoint: Endpoint,
  prompt: string
): Promise<CodexRunResult> {
  const resumed = await runCodexOnce(config.runtime.command, buildCodexArgs(config.runtime.args, prompt), workspace);

  if (resumed.exitCode === 0) {
    return {
      ...resumed,
      response: extractFinalResponse(resumed.stdout, resumed.stderr),
      resumed: true
    };
  }

  const fresh = await runCodexOnce(config.runtime.command, buildFreshCodexArgs(prompt), workspace);

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

async function runCodexOnce(command: string, args: string[], cwd: string): Promise<Omit<CodexRunResult, "response" | "resumed">> {
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
