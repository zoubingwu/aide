import type { AideConfig, AgentProvider, AgentRunResult, Endpoint } from "./types.js";
import { runCodex } from "./codex.js";

export function makeAssistantPrompt(endpoint: Endpoint, message: string, author: string): string {
  return `Endpoint: ${endpoint.id}
Provider: ${endpoint.provider}
Author: ${author}

${message}`;
}

export async function runAgent(
  config: AideConfig,
  workspace: string,
  endpoint: Endpoint,
  prompt: string
): Promise<AgentRunResult> {
  switch (config.runtime.provider) {
    case "codex":
      return runCodex(config, workspace, endpoint, prompt);
  }
}

export function agentProviderLabel(provider: AgentProvider): string {
  switch (provider) {
    case "codex":
      return "Codex";
  }
}
