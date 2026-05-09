import type { EndpointTriggerConfig } from "../types.js";

export type ImportSource = "hermes" | "openclaw" | "all";

export type ImportCandidate = ReadyImportCandidate | SecretImportCandidate;
export type OpenClawSecretRefSource = "file" | "exec";

export interface ImportCandidateBase {
  source: Exclude<ImportSource, "all">;
  sourceName: string;
  sourcePath: string;
  endpointId: string;
  trigger: EndpointTriggerConfig;
  disabledReason?: string | undefined;
}

export interface ReadyImportCandidate extends ImportCandidateBase {
  kind: "ready";
  token: string;
}

export interface SecretImportCandidate extends ImportCandidateBase {
  kind: "secret";
  secret: OpenClawSecretResolution;
}

export interface OpenClawSecretResolution {
  ref: OpenClawSecretRef;
  provider: OpenClawSecretProvider;
}

export interface OpenClawSecretRef {
  source: "env" | OpenClawSecretRefSource;
  provider: string;
  id: string;
}

export type OpenClawSecretProvider =
  OpenClawFileSecretProvider |
  OpenClawExecSecretProvider |
  OpenClawShellEnvSecretProvider;

export interface OpenClawFileSecretProvider {
  source: "file";
  path: string;
  mode?: "json" | "singleValue" | undefined;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
}

export interface OpenClawExecSecretProvider {
  source: "exec";
  command: string;
  args?: string[] | undefined;
  passEnv?: string[] | undefined;
  env?: Record<string, string> | undefined;
  jsonOnly?: boolean | undefined;
  timeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
}

export interface OpenClawShellEnvSecretProvider {
  source: "shellEnv";
  keys: string[];
  command: string;
  values: Record<string, string>;
  configEnv?: Record<string, unknown> | undefined;
  tokenInput?: unknown;
  fallbackKey?: string | undefined;
  config: unknown;
}

export interface ImportPlanEntry {
  candidate: ReadyImportCandidate;
  endpointId: string;
  tokenFingerprint: string;
  action: "create" | "skip";
  reason?: string | undefined;
}

export interface ImportDiscoveryOptions {
  env?: NodeJS.ProcessEnv | undefined;
  cwd?: string | undefined;
  hermesHome?: string | undefined;
  openclawHome?: string | undefined;
  openclawConfigPath?: string | undefined;
}

export interface SourceEnv {
  values: Record<string, string>;
  paths: string[];
}
