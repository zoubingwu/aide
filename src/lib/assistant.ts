import { makeAssistantPrompt, runAgent } from "./agent.js";
import { appendActivityLog, endpointActivity } from "./logging.js";
import { estimateTokens, addCodexUsage, addEstimatedUsage } from "./usage.js";
import { assertEndpointWorkspace, endpointWorkspace } from "./workspace.js";
import type { AgentRunResult, Endpoint } from "./types.js";

export interface AssistantRequestContext {
  source?: string | undefined;
}

export async function handleAssistantRequest(
  home: string,
  endpoint: Endpoint,
  message: string,
  author: string,
  context: AssistantRequestContext = {}
): Promise<AgentRunResult> {
  assertEndpointWorkspace(home, endpoint);
  const prompt = makeAssistantPrompt(endpoint, message, author, context);
  const workspace = endpointWorkspace(home, endpoint);

  appendActivityLog(home, endpointActivity(home, endpoint, "message_received", { author }));
  appendActivityLog(home, endpointActivity(home, endpoint, "agent_request", { provider: endpoint.agent.provider, workspace }));

  const result = await runAgent(home, workspace, endpoint, prompt);
  const estimatedTokens = estimateTokens(prompt) + estimateTokens(result.response);
  const tokens = result.usageTokens ?? estimatedTokens;

  if (result.usageTokens === undefined) {
    addEstimatedUsage(home, endpoint, tokens);
  } else {
    addCodexUsage(home, endpoint, tokens);
  }

  appendActivityLog(home, {
    ...endpointActivity(home, endpoint, "agent_response", {
      provider: endpoint.agent.provider,
      exitCode: result.exitCode,
      resumed: result.resumed
    }),
    tokens
  });

  return result;
}
