export interface AgentToolServer {
  name: string;
  url: string;
}

export interface ManagedAgentToolServer extends AgentToolServer {
  stop(): Promise<void>;
}

export interface AgentRunOptions {
  toolServers?: AgentToolServer[] | undefined;
}
