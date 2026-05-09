import crypto from "node:crypto";
import prompts from "prompts";
import {
  describeSecretImportCandidate,
  discoverImportCandidates,
  importPlanEntryEndpoint,
  planEndpointImports,
  resolveSecretImportCandidate,
  type ImportCandidate,
  type ImportPlanEntry,
  type ReadyImportCandidate,
  type ImportSource
} from "../lib/import-sources.js";
import {
  ensureAideHome,
  loadEndpoints,
  writeEndpoints
} from "../lib/config.js";
import { displayPath } from "../lib/paths.js";
import { startRuntimeInBackground, stopRuntime } from "../lib/runtime.js";
import { runtimeDisplayStatus } from "../lib/runtime-state.js";
import type { Provider } from "../lib/types.js";
import { ensureEndpointWorkspace, endpointWorkspace } from "../lib/workspace.js";
import type { CommandOptions } from "./options.js";
import { homeFromOptions } from "./options.js";

const IMPORT_SOURCES: ImportSource[] = ["hermes", "openclaw", "all"];

export async function importCommand(source: string, options: CommandOptions): Promise<void> {
  const importSource = parseImportSource(source);
  const home = homeFromOptions(options);

  await runEndpointImport(home, importSource, { promptRuntime: true });
}

export interface EndpointImportResult {
  discoveredCount: number;
  plannedCount: number;
  importedCount: number;
}

export async function runEndpointImport(
  home: string,
  importSource: ImportSource,
  options: { promptRuntime: boolean }
): Promise<EndpointImportResult> {
  ensureAideHome(home);

  const endpoints = loadEndpoints(home);
  const discoveredCandidates = discoverImportCandidates(importSource);

  console.log(`Aide Import: ${importSourceLabel(importSource)}\n`);

  if (discoveredCandidates.length === 0) {
    console.log("No Discord bot tokens found.");
    return { discoveredCount: 0, plannedCount: 0, importedCount: 0 };
  }

  console.log(importDiscoverySummary(discoveredCandidates));

  const candidates = await resolveImportCandidates(discoveredCandidates);
  const plan = planEndpointImports(endpoints, candidates);
  const createEntries = plan.filter((entry) => entry.action === "create");

  if (plan.length === 0) {
    console.log("\nNo importable Discord bot tokens found.");
    return {
      discoveredCount: discoveredCandidates.length,
      plannedCount: 0,
      importedCount: 0
    };
  }

  console.log("\nImport plan:");
  console.log(importPlanSummary(plan));

  if (createEntries.length === 0) {
    console.log("\nNo new endpoints imported.");
    return {
      discoveredCount: discoveredCandidates.length,
      plannedCount: plan.length,
      importedCount: 0
    };
  }

  if (process.stdin.isTTY) {
    const response = await prompts({
      type: "confirm",
      name: "confirmed",
      message: `Import ${createEntries.length} endpoint${createEntries.length === 1 ? "" : "s"}?`,
      initial: true
    });

    if (!response.confirmed) {
      console.log("\nImport cancelled.");
      return {
        discoveredCount: discoveredCandidates.length,
        plannedCount: plan.length,
        importedCount: 0
      };
    }
  }

  const nextEndpoints = [...endpoints, ...createEntries.map(importPlanEntryEndpoint)];
  writeEndpoints(home, nextEndpoints);

  for (const endpoint of createEntries.map(importPlanEntryEndpoint)) {
    ensureEndpointWorkspace(home, endpoint);
  }

  console.log("\nImported:");

  for (const entry of createEntries) {
    const endpoint = importPlanEntryEndpoint(entry);
    console.log(`- ${entry.endpointId} (${providerLabel(entry.candidate.provider)}), ${endpointStatusLabel()}`);
    console.log(`  Workspace: ${displayPath(endpointWorkspace(home, endpoint))}`);
  }

  printImportWarnings(createEntries);

  if (options.promptRuntime) {
    await promptRuntimeReload(home);
  }

  return {
    discoveredCount: discoveredCandidates.length,
    plannedCount: plan.length,
    importedCount: createEntries.length
  };
}

async function resolveImportCandidates(candidates: ImportCandidate[]): Promise<ReadyImportCandidate[]> {
  const ready: ReadyImportCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.kind === "ready") {
      ready.push(candidate);
      continue;
    }

    if (!process.stdin.isTTY) {
      console.log(
        `Skipped ${candidate.source}:${candidate.sourceName}: SecretRef requires confirmation (${describeSecretImportCandidate(candidate)}).`
      );
      continue;
    }

    const response = await prompts({
      type: "confirm",
      name: "confirmed",
      message: `Resolve ${candidate.source}:${candidate.sourceName} SecretRef from ${describeSecretImportCandidate(candidate)}?`,
      initial: false
    });

    if (!response.confirmed) {
      console.log(`Skipped ${candidate.source}:${candidate.sourceName}.`);
      continue;
    }

    try {
      ready.push(await resolveSecretImportCandidate(candidate));
    } catch (error) {
      console.log(`Skipped ${candidate.source}:${candidate.sourceName}: ${errorMessage(error)}.`);
    }
  }

  return ready;
}

function parseImportSource(value: string): ImportSource {
  if (IMPORT_SOURCES.includes(value as ImportSource)) {
    return value as ImportSource;
  }

  throw new Error(`Import source must be one of: ${IMPORT_SOURCES.join(", ")}.`);
}

function importSourceLabel(source: ImportSource): string {
  if (source === "openclaw") {
    return "OpenClaw";
  }

  if (source === "hermes") {
    return "Hermes";
  }

  return "all";
}

function importDiscoverySummary(candidates: ImportCandidate[]): string {
  const lines = openClawConfigLines(candidates);

  if (lines.length > 0) {
    lines.push("");
  }

  lines.push("Found endpoints:");

  for (const candidate of candidates) {
    lines.push(`- ${sourceLocationLabel(candidate)} -> ${candidate.endpointId} (${providerLabel(candidate.provider)}), ${importCandidateStatus(candidate)}`);
  }

  return lines.join("\n");
}

function openClawConfigLines(candidates: ImportCandidate[]): string[] {
  const paths = [
    ...new Set(
      candidates
        .filter((candidate) => candidate.source === "openclaw")
        .map((candidate) => candidate.sourcePath)
    )
  ];

  return paths.map((sourcePath) => `OpenClaw config: ${displayPath(sourcePath)}`);
}

function importCandidateTokenLabel(candidate: ImportCandidate): string {
  if (candidate.kind === "secret") {
    return `SecretRef ${candidate.secret.provider.source}`;
  }

  return tokenFingerprint(candidate.token).slice(0, 15);
}

function importCandidateStatus(candidate: ImportCandidate): string {
  if (candidate.kind === "secret") {
    return `token requires confirmation (${importCandidateTokenLabel(candidate)})`;
  }

  return "ready";
}

function importPlanSummary(plan: ImportPlanEntry[]): string {
  return plan
    .map((entry) => `- ${sourceLocationLabel(entry.candidate)} -> ${entry.endpointId}: ${importPlanActionLabel(entry)}`)
    .join("\n");
}

function importPlanActionLabel(entry: ImportPlanEntry): string {
  if (entry.action === "skip") {
    return `skip (${entry.reason ?? "already handled"})`;
  }

  return "create";
}

function sourceLocationLabel(candidate: ImportCandidate): string {
  if (candidate.source === "openclaw") {
    const account = candidate.sourceName === "default" ? "default" : `account ${candidate.sourceName}`;
    return `OpenClaw channels.${candidate.sourceChannel} ${account}`;
  }

  const profile = candidate.sourceName === "default" ? "default profile" : `profile ${candidate.sourceName}`;
  return `Hermes ${profile}`;
}

function providerLabel(provider: Provider): string {
  return provider === "discord" ? "Discord" : provider;
}

function endpointStatusLabel(): string {
  return "enabled";
}

function printImportWarnings(entries: ImportPlanEntry[]): void {
  const warningEntries = entries.filter((entry) => entry.candidate.warning);

  if (warningEntries.length === 0) {
    return;
  }

  console.log("\nWarnings:");

  for (const entry of warningEntries) {
    console.log(`- ${entry.endpointId}: ${entry.candidate.warning}.`);
  }
}

async function promptRuntimeReload(home: string): Promise<void> {
  const current = runtimeDisplayStatus(home);

  if (!process.stdin.isTTY) {
    console.log(`\nRun \`aide ${current.status === "running" ? "restart" : "start"}\` to use imported endpoints.`);
    return;
  }

  const command = current.status === "running" ? "restart" : "start";
  const response = await prompts({
    type: "confirm",
    name: "confirmed",
    message: `${command === "restart" ? "Restart" : "Start"} Aide now to use imported endpoints?`,
    initial: true
  });

  if (!response.confirmed) {
    console.log(`\nRun \`aide ${command}\` to use imported endpoints.`);
    return;
  }

  if (current.status === "running") {
    stopRuntime(home);
  }

  await startRuntimeInBackground(home);
}

function tokenFingerprint(token: string): string {
  return `sha256:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
