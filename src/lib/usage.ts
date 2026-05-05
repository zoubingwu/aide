import fs from "node:fs";
import path from "node:path";
import { assertInitialized } from "./config.js";
import { usagePath } from "./paths.js";
import type { Endpoint, UsageEntry } from "./types.js";

export interface UsageSummary {
  today: number;
  total: number;
  byEndpoint: Array<{ endpoint: string; tokens: number }>;
  source: "estimated" | "codex";
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function todayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function addEstimatedUsage(home: string, endpoint: Endpoint, tokens: number, date = new Date()): void {
  const entry: UsageEntry = {
    day: todayKey(date),
    endpoint: endpoint.id,
    provider: endpoint.provider,
    tokens,
    source: "estimated"
  };

  appendUsageEntry(home, entry);
}

export function summarizeUsage(home: string, date = new Date()): UsageSummary {
  const entries = readUsageEntries(home);
  const day = todayKey(date);
  const byEndpointMap = new Map<string, number>();
  let today = 0;
  let total = 0;

  for (const entry of entries) {
    total += entry.tokens;
    byEndpointMap.set(entry.endpoint, (byEndpointMap.get(entry.endpoint) ?? 0) + entry.tokens);

    if (entry.day === day) {
      today += entry.tokens;
    }
  }

  return {
    today,
    total,
    source: entries.some((entry) => entry.source === "codex") ? "codex" : "estimated",
    byEndpoint: [...byEndpointMap.entries()]
      .map(([endpoint, tokens]) => ({ endpoint, tokens }))
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
