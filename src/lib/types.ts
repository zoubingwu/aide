export type Provider = "discord";
export type AgentProvider = "codex";
export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type AgentOutputMode = "concise" | "verbose";
export type RuntimeStatus = "running" | "stopped";

export interface CodexAgentConfig {
  provider: "codex";
  command: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  outputMode: AgentOutputMode;
}

export type AgentConfig = CodexAgentConfig;

export interface EndpointTriggerConfig {
  requireMention: boolean;
  freeResponseSources: string[];
}

export interface Endpoint {
  id: string;
  provider: Provider;
  enabled: boolean;
  token: string;
  trigger: EndpointTriggerConfig;
  agent: AgentConfig;
}

export type ScheduleKind = "cron" | "hourly" | "daily" | "weekly" | "biweekly" | "monthly" | "once";

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
  cron?: string | undefined;
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
  hasTextResponse: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  resumed: boolean;
  usage?: AgentUsage | undefined;
  usageTokens?: number | undefined;
}

export interface UsageEntry {
  createdAt?: string | undefined;
  day?: string | undefined;
  endpoint: string;
  provider: Provider;
  agent?: AgentProvider | undefined;
  tokens: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  reasoningOutputTokens?: number | undefined;
  source: "estimated" | "codex";
  raw?: Record<string, unknown> | undefined;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number | undefined;
  reasoningOutputTokens?: number | undefined;
  raw?: Record<string, unknown> | undefined;
}

export interface DoctorCheck {
  status: "ok" | "warn" | "fail";
  label: string;
  detail?: string;
  endpointId?: string;
}
