import { defaultCodexAgentConfig } from "../config.js";
import type { Endpoint } from "../types.js";
import { nextEndpointId, tokenFingerprint } from "./helpers.js";
import type { ImportCandidate, ImportPlanEntry, ReadyImportCandidate } from "./types.js";

export function readyImportCandidates(candidates: ImportCandidate[]): ReadyImportCandidate[] {
  return candidates.filter((candidate): candidate is ReadyImportCandidate => candidate.kind === "ready");
}

export function planEndpointImports(existingEndpoints: Endpoint[], candidates: ReadyImportCandidate[]): ImportPlanEntry[] {
  const entries: ImportPlanEntry[] = [];
  const usedIds = new Set(existingEndpoints.map((endpoint) => endpoint.id));
  const existingTokenOwners = new Map<string, string>();
  const plannedTokenOwners = new Map<string, string>();

  for (const endpoint of existingEndpoints) {
    existingTokenOwners.set(tokenFingerprint(endpoint.token), endpoint.id);
  }

  for (const candidate of candidates) {
    const fingerprint = tokenFingerprint(candidate.token);
    const existingOwner = existingTokenOwners.get(fingerprint);

    if (existingOwner) {
      entries.push({
        candidate,
        endpointId: existingOwner,
        tokenFingerprint: fingerprint,
        action: "skip",
        reason: `already imported as ${existingOwner}`
      });
      continue;
    }

    const plannedOwner = plannedTokenOwners.get(fingerprint);

    if (plannedOwner) {
      entries.push({
        candidate,
        endpointId: plannedOwner,
        tokenFingerprint: fingerprint,
        action: "skip",
        reason: `same token as ${plannedOwner}`
      });
      continue;
    }

    const endpointId = nextEndpointId(candidate.endpointId, usedIds);
    usedIds.add(endpointId);
    plannedTokenOwners.set(fingerprint, endpointId);
    entries.push({
      candidate,
      endpointId,
      tokenFingerprint: fingerprint,
      action: "create"
    });
  }

  return entries;
}

export function importPlanEntryEndpoint(entry: ImportPlanEntry): Endpoint {
  return {
    id: entry.endpointId,
    provider: entry.candidate.provider,
    enabled: true,
    token: entry.candidate.token,
    trigger: entry.candidate.trigger,
    agent: defaultCodexAgentConfig()
  };
}
