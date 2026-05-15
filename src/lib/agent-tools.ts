export interface AgentToolServer {
  name: string;
  url: string;
}

export interface ManagedAgentToolServer extends AgentToolServer {
  stop(): Promise<void>;
}

export interface AgentRunEvent {
  attempt?: string | undefined;
  type?: string | undefined;
  payload: Record<string, unknown>;
}

export interface AgentRunOptions {
  toolServers?: AgentToolServer[] | undefined;
  onEvent?: ((event: AgentRunEvent) => void | Promise<void>) | undefined;
  abortSignal?: AbortSignal | undefined;
  deferredRestartId?: string | undefined;
}
