import fs from "node:fs";
import path from "node:path";
import { assertInitialized } from "./config.js";
import { usagePath } from "./paths.js";
import type { AgentUsage, Endpoint, UsageEntry } from "./types.js";

export interface UsageSummary {
  today: number;
  total: number;
  todayInputTokens: number;
  todayOutputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byEndpoint: Array<{ endpoint: string; tokens: number; inputTokens: number; outputTokens: number }>;
  source: "estimated" | "codex" | "mixed";
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function todayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function addEstimatedUsage(
  home: string,
  endpoint: Endpoint,
  inputTokens: number,
  outputTokens: number,
  date = new Date()
): void {
  addUsage(home, endpoint, usageDetails(inputTokens, outputTokens), "estimated", date);
}

export function addCodexUsage(home: string, endpoint: Endpoint, usage: AgentUsage, date = new Date()): void {
  addUsage(home, endpoint, usage, "codex", date);
}

function addUsage(home: string, endpoint: Endpoint, usage: AgentUsage, source: UsageEntry["source"], date: Date): void {
  const entry: UsageEntry = {
    createdAt: date.toISOString(),
    endpoint: endpoint.id,
    provider: endpoint.provider,
    agent: endpoint.agent.provider,
    tokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    source,
    raw: usage.raw
  };

  appendUsageEntry(home, entry);
}

export function summarizeUsage(home: string, date = new Date()): UsageSummary {
  const entries = readUsageEntries(home);
  const day = todayKey(date);
  const byEndpointMap = new Map<string, { tokens: number; inputTokens: number; outputTokens: number }>();
  const sources = new Set<UsageEntry["source"]>();
  let today = 0;
  let todayInputTokens = 0;
  let todayOutputTokens = 0;
  let total = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const entry of entries) {
    const usage = entryUsage(entry);
    const endpointUsage = byEndpointMap.get(entry.endpoint) ?? { tokens: 0, inputTokens: 0, outputTokens: 0 };

    total += usage.tokens;
    totalInputTokens += usage.inputTokens;
    totalOutputTokens += usage.outputTokens;
    endpointUsage.tokens += usage.tokens;
    endpointUsage.inputTokens += usage.inputTokens;
    endpointUsage.outputTokens += usage.outputTokens;
    byEndpointMap.set(entry.endpoint, endpointUsage);
    sources.add(entry.source);

    if (entryDay(entry) === day) {
      today += usage.tokens;
      todayInputTokens += usage.inputTokens;
      todayOutputTokens += usage.outputTokens;
    }
  }

  return {
    today,
    total,
    todayInputTokens,
    todayOutputTokens,
    totalInputTokens,
    totalOutputTokens,
    source: sources.size > 1 ? "mixed" : sources.has("codex") ? "codex" : "estimated",
    byEndpoint: [...byEndpointMap.entries()]
      .map(([endpoint, usage]) => ({ endpoint, ...usage }))
      .sort((left, right) => right.tokens - left.tokens)
  };
}

export function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function appendUsageEntry(home: string, entry: UsageEntry): void {
  assertInitialized(home);
  fs.mkdirSync(path.dirname(usagePath(home)), { recursive: true });
  fs.appendFileSync(usagePath(home), `${JSON.stringify(entry)}\n`);
}

export function readUsageEntries(home: string): UsageEntry[] {
  assertInitialized(home);
  const filePath = usagePath(home);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as UsageEntry);
}

function usageDetails(inputTokens: number, outputTokens: number): AgentUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
  };
}

function entryUsage(entry: UsageEntry): { tokens: number; inputTokens: number; outputTokens: number } {
  if (entry.inputTokens !== undefined || entry.outputTokens !== undefined) {
    const inputTokens = entry.inputTokens ?? 0;
    const outputTokens = entry.outputTokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      tokens: entry.tokens
    };
  }

  return {
    inputTokens: entry.tokens,
    outputTokens: 0,
    tokens: entry.tokens
  };
}

function entryDay(entry: UsageEntry): string | undefined {
  if (entry.createdAt) {
    const timestamp = Date.parse(entry.createdAt);

    if (Number.isFinite(timestamp)) {
      return todayKey(new Date(timestamp));
    }
  }

  return entry.day;
}
