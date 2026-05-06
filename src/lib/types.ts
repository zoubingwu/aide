export type Provider = "discord";
export type AgentProvider = "codex";
export type RuntimeStatus = "running" | "stopped";

export interface RuntimeConfig {
  provider: AgentProvider;
  command: string;
  args: string[];
  startupTimeoutMs: number;
}

export interface AideConfig {
  home: string;
  runtime: RuntimeConfig;
}

export interface Endpoint {
  id: string;
  provider: Provider;
  enabled: boolean;
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

export interface AgentRunResult {
  response: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  resumed: boolean;
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
