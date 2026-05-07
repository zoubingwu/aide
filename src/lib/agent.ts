import type { AgentProvider, AgentRunResult, Endpoint } from "./types.js";
import { runCodex } from "./codex.js";

export interface AssistantPromptContext {
  source?: string | undefined;
}

export function makeAssistantPrompt(endpoint: Endpoint, message: string, author: string, context: AssistantPromptContext = {}): string {
  const source = context.source ? `Source: ${context.source}\n` : "";

  return `Endpoint: ${endpoint.id}
Provider: ${endpoint.provider}
Author: ${author}
${source}
Scheduling: Use aide schedule commands for delayed reminders, relative-time reminders, recurring work, and timed follow-ups. For short delays such as "in 3 minutes", create a one-shot schedule with --kind once and --run-at. Shell sleeps and long-running waits are unsuitable for reminder requests.

${message}`;
}

export async function runAgent(
  home: string,
  workspace: string,
  endpoint: Endpoint,
  prompt: string
): Promise<AgentRunResult> {
  switch (endpoint.agent.provider) {
    case "codex":
      return runCodex(home, workspace, endpoint, prompt);
  }
}

export function agentProviderLabel(provider: AgentProvider): string {
  switch (provider) {
    case "codex":
      return "Codex";
  }
}
