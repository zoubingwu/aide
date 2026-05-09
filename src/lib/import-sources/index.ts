import { discoverHermesCandidates } from "./hermes.js";
import { discoverOpenClawCandidates } from "./openclaw.js";
import { resolveOpenClawSecretCandidate } from "./openclaw-secrets.js";
import type { ImportCandidate, ImportDiscoveryOptions, ImportSource, ReadyImportCandidate, SecretImportCandidate } from "./types.js";

export type {
  ImportCandidate,
  ImportCandidateBase,
  ImportDiscoveryOptions,
  ImportPlanEntry,
  ImportSource,
  OpenClawExecSecretProvider,
  OpenClawFileSecretProvider,
  OpenClawSecretProvider,
  OpenClawSecretRef,
  OpenClawSecretRefSource,
  OpenClawSecretResolution,
  OpenClawShellEnvSecretProvider,
  ReadyImportCandidate,
  SecretImportCandidate
} from "./types.js";
export { importPlanEntryEndpoint, planEndpointImports, readyImportCandidates } from "./plan.js";

export function discoverImportCandidates(source: ImportSource, options: ImportDiscoveryOptions = {}): ImportCandidate[] {
  switch (source) {
    case "hermes":
      return discoverHermesCandidates(options);
    case "openclaw":
      return discoverOpenClawCandidates(options);
    case "all":
      return [
        ...discoverHermesCandidates(options),
        ...discoverOpenClawCandidates(options)
      ];
  }
}

export async function resolveSecretImportCandidate(
  candidate: SecretImportCandidate,
  options: ImportDiscoveryOptions = {}
): Promise<ReadyImportCandidate> {
  return {
    ...candidate,
    kind: "ready",
    token: await resolveOpenClawSecretCandidate(candidate.secret, options)
  };
}

export function describeSecretImportCandidate(candidate: SecretImportCandidate): string {
  const { ref, provider } = candidate.secret;

  if (provider.source === "file") {
    return `file ${provider.path} (${provider.mode ?? "json"}:${ref.id})`;
  }

  if (provider.source === "shellEnv") {
    return `shellEnv ${provider.keys.join(", ")} via ${provider.command}`;
  }

  return `exec ${[provider.command, ...(provider.args ?? [])].join(" ")} (${ref.id})`;
}
