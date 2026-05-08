import { agentProviderLabel as catalogAgentProviderLabel } from "./agents.js";
import type { AgentProvider, AgentRunResult, Endpoint } from "./types.js";
import type { AgentRunOptions } from "./agent-tools.js";
import { runCodex } from "./codex.js";

export interface AssistantPromptContext {
  source?: string | undefined;
  metadata?: AssistantPromptMetadata[] | undefined;
}

export interface AssistantPromptMetadata {
  label: string;
  value?: string | undefined;
}

export function makeAssistantPrompt(message: string, author: string, context: AssistantPromptContext = {}): string {
  const metadata = ["# Metadata", "", `Author: ${author}`];

  if (context.source) {
    metadata.push(`Source: ${context.source}`);
  }

  for (const item of context.metadata ?? []) {
    if (item.value) {
      metadata.push(`${item.label}: ${item.value}`);
    }
  }

  return `${metadata.join("\n")}\n\n# User Message\n\n${message}`;
}

export async function runAgent(
  home: string,
  workspace: string,
  endpoint: Endpoint,
  prompt: string,
  options: AgentRunOptions = {}
): Promise<AgentRunResult> {
  switch (endpoint.agent.provider) {
    case "codex":
      return runCodex(home, workspace, endpoint, prompt, options);
  }
}

export function agentProviderLabel(provider: AgentProvider): string {
  return catalogAgentProviderLabel(provider);
}
