import prompts from "prompts";
import {
  discoverImportCandidates,
  importPlanEntryEndpoint,
  planEndpointImports,
  type ImportPlanEntry,
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
  const candidates = discoverImportCandidates(importSource);
  const plan = planEndpointImports(endpoints, candidates);
  const createEntries = plan.filter((entry) => entry.action === "create");

  console.log(`Aide Import: ${importSource}\n`);

  if (plan.length === 0) {
    console.log("No Discord bot tokens found.");
    return;
  }

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
    console.log(`Imported ${entry.endpointId} from ${entry.candidate.source}:${entry.candidate.sourceName}.`);
    console.log(`Workspace ${displayPath(endpointWorkspace(home, importPlanEntryEndpoint(entry)))}`);
  }

  console.log("\nRun `aide start` or `aide restart` to use imported endpoints.");
}

function parseImportSource(value: string): ImportSource {
  if (IMPORT_SOURCES.includes(value as ImportSource)) {
    return value as ImportSource;
  }

  throw new Error(`Import source must be one of: ${IMPORT_SOURCES.join(", ")}.`);
}

function importPlanTable(plan: ImportPlanEntry[]): string {
  return printTable(
    ["Source", "Name", "Endpoint", "Token", "Action"],
    plan.map((entry) => [
      entry.candidate.source,
      entry.candidate.sourceName,
      entry.endpointId,
      entry.tokenFingerprint.slice(0, 15),
      entry.action === "create" ? "create" : `skip (${entry.reason ?? "already handled"})`
    ])
  );
}
