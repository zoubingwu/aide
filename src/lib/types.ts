export type Provider = "discord";
export type AgentProvider = "codex";
export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type RuntimeStatus = "running" | "stopped";

export interface RuntimeConfig {
  provider: AgentProvider;
  command: string;
  args: string[];
  model: string;
  reasoningEffort: CodexReasoningEffort;
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

export type ScheduleKind = "hourly" | "daily" | "weekly" | "biweekly" | "monthly" | "once";

export type Weekday =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday";

export interface Schedule {
  id: string;
  endpoint: string;
  enabled: boolean;
  kind: ScheduleKind;
  target: string;
  message: string;
  timezone?: string | undefined;
  time?: string | undefined;
  weekday?: Weekday | undefined;
  day?: number | undefined;
  minute?: number | undefined;
  startDate?: string | undefined;
  runAt?: string | undefined;
}

export interface SchedulesFile {
  schedules: Schedule[];
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
