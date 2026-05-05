export type Provider = "discord";
export type RoutingMode = "mention_only";
export type RuntimeStatus = "running" | "stopped";

export interface RuntimeConfig {
  command: string;
  args: string[];
  startupTimeoutMs: number;
}

export interface AideConfig {
  home: string;
  runtime: RuntimeConfig;
}

export interface EndpointRouting {
  mode: RoutingMode;
  server: string;
  channel: string;
}

export interface EndpointPermissions {
  requireApprovalForShell: boolean;
  requireApprovalForWrites: boolean;
  restrictToEndpointWorkspace: boolean;
}

export interface Endpoint {
  id: string;
  provider: Provider;
  name: string;
  enabled: boolean;
  workspacePath: string;
  routing: EndpointRouting;
  permissions: EndpointPermissions;
}

export interface EndpointsFile {
  endpoints: Endpoint[];
}

export interface RuntimeState {
  status: RuntimeStatus;
  home: string;
  pid?: number | undefined;
  startedAt?: string | undefined;
}

export interface UsageEntry {
  day: string;
  endpoint: string;
  provider: Provider;
  tokens: number;
  source: "estimated" | "codex";
}

export interface DoctorCheck {
  status: "ok" | "warn" | "fail";
  label: string;
  detail?: string;
}
