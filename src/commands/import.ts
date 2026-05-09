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
import { printTable } from "../lib/format.js";
import { displayPath } from "../lib/paths.js";
import { ensureEndpointWorkspace, endpointWorkspace } from "../lib/workspace.js";
import type { CommandOptions } from "./options.js";
import { homeFromOptions } from "./options.js";

const IMPORT_SOURCES: ImportSource[] = ["hermes", "openclaw", "all"];

export async function importCommand(source: string, options: CommandOptions): Promise<void> {
  const importSource = parseImportSource(source);
  const home = homeFromOptions(options);
  ensureAideHome(home);

  const endpoints = loadEndpoints(home);
  const discoveredCandidates = discoverImportCandidates(importSource);

  console.log(`Aide Import: ${importSource}\n`);

  if (discoveredCandidates.length === 0) {
    console.log("No Discord bot tokens found.");
    return;
  }

  console.log("Discovered endpoints:");
  console.log(importCandidateTable(discoveredCandidates));

  const candidates = await resolveImportCandidates(discoveredCandidates);
  const plan = planEndpointImports(endpoints, candidates);
  const createEntries = plan.filter((entry) => entry.action === "create");

  if (plan.length === 0) {
    console.log("\nNo importable Discord bot tokens found.");
    return;
  }

  console.log("\nImport plan:");
  console.log(importPlanTable(plan));

  if (createEntries.length === 0) {
    console.log("\nNo new endpoints imported.");
    return;
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
      return;
    }
  }

  const nextEndpoints = [...endpoints, ...createEntries.map(importPlanEntryEndpoint)];
  writeEndpoints(home, nextEndpoints);

  for (const endpoint of createEntries.map(importPlanEntryEndpoint)) {
    ensureEndpointWorkspace(home, endpoint);
  }

  console.log("");

  for (const entry of createEntries) {
    const status = entry.candidate.disabledReason ? ` disabled (${entry.candidate.disabledReason})` : "";
    console.log(`Imported ${entry.endpointId} from ${entry.candidate.source}:${entry.candidate.sourceName}${status}.`);
    console.log(`Workspace ${displayPath(endpointWorkspace(home, importPlanEntryEndpoint(entry)))}`);
  }

  console.log("\nRun `aide start` or `aide restart` to use imported endpoints.");
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

function importCandidateTable(candidates: ImportCandidate[]): string {
  return printTable(
    ["Source", "Name", "Endpoint", "Token", "Status", "Path"],
    candidates.map((candidate) => [
      candidate.source,
      candidate.sourceName,
      candidate.endpointId,
      importCandidateTokenLabel(candidate),
      importCandidateStatus(candidate),
      displayPath(candidate.sourcePath)
    ])
  );
}

function importCandidateTokenLabel(candidate: ImportCandidate): string {
  if (candidate.kind === "secret") {
    return `SecretRef ${candidate.secret.provider.source}`;
  }

  return tokenFingerprint(candidate.token).slice(0, 15);
}

function importCandidateStatus(candidate: ImportCandidate): string {
  return candidate.disabledReason ? `disabled (${candidate.disabledReason})` : "enabled";
}

function importPlanTable(plan: ImportPlanEntry[]): string {
  return printTable(
    ["Source", "Name", "Endpoint", "Token", "Action"],
    plan.map((entry) => [
      entry.candidate.source,
      entry.candidate.sourceName,
      entry.endpointId,
      entry.tokenFingerprint.slice(0, 15),
      importPlanActionLabel(entry)
    ])
  );
}

function importPlanActionLabel(entry: ImportPlanEntry): string {
  if (entry.action === "skip") {
    return `skip (${entry.reason ?? "already handled"})`;
  }

  return entry.candidate.disabledReason ? `create disabled (${entry.candidate.disabledReason})` : "create";
}

function tokenFingerprint(token: string): string {
  return `sha256:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
