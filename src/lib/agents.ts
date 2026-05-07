import { execa } from "execa";
import { defaultCodexAgentConfig } from "./config.js";
import type { AgentConfig, AgentProvider } from "./types.js";

export interface AgentDefinition {
  provider: AgentProvider;
  label: string;
  command: string;
  versionArgs: string[];
}

export interface InstalledAgent {
  provider: AgentProvider;
  label: string;
  command: string;
  version?: string | undefined;
}

export type AgentCommandOverrides = Partial<Record<AgentProvider, string>>;

export const AGENT_CATALOG = [
  {
    provider: "codex",
    label: "Codex",
    command: "codex",
    versionArgs: ["--version"]
  }
] as const satisfies readonly AgentDefinition[];

export function defaultAgentConfig(provider: AgentProvider): AgentConfig {
  switch (provider) {
    case "codex":
      return defaultCodexAgentConfig();
  }
}

export function agentDefinition(provider: AgentProvider): AgentDefinition {
  const definition = AGENT_CATALOG.find((candidate) => candidate.provider === provider);

  if (!definition) {
    throw new Error(`Unsupported agent provider: ${provider}.`);
  }

  return definition;
}

export function agentProviderLabel(provider: AgentProvider): string {
  return agentDefinition(provider).label;
}

export function parseAgentProvider(value: string): AgentProvider {
  if (isAgentProvider(value)) {
    return value;
  }

  throw new Error(`Agent provider must be one of: ${AGENT_CATALOG.map((agent) => agent.provider).join(", ")}.`);
}

export async function detectInstalledAgents(commandOverrides: AgentCommandOverrides = {}): Promise<InstalledAgent[]> {
  const results = await Promise.all(AGENT_CATALOG.map((definition) => detectInstalledAgent(definition, commandOverrides)));
  return results.filter((result): result is InstalledAgent => Boolean(result));
}

async function detectInstalledAgent(
  definition: AgentDefinition,
  commandOverrides: AgentCommandOverrides
): Promise<InstalledAgent | undefined> {
  const command = commandOverrides[definition.provider] ?? definition.command;

  try {
    const result = await execa(command, definition.versionArgs, { reject: false });

    if (result.exitCode !== 0) {
      return undefined;
    }

    const version = (result.stdout.trim() || result.stderr.trim()) || undefined;
    return version
      ? { provider: definition.provider, label: definition.label, command, version }
      : { provider: definition.provider, label: definition.label, command };
  } catch {
    return undefined;
  }
}

function isAgentProvider(value: string): value is AgentProvider {
  return AGENT_CATALOG.some((agent) => agent.provider === value);
}
