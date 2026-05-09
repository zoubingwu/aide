import { makeAssistantPrompt, runAgent } from "./agent.js";
import { appendActivityLog, endpointActivity } from "./logging.js";
import { estimateTokens, addCodexUsage, addEstimatedUsage } from "./usage.js";
import { assertEndpointWorkspace, endpointWorkspace } from "./workspace.js";
import type { AgentToolServer } from "./agent-tools.js";
import type { AssistantPromptMetadata } from "./agent.js";
import type { AgentRunResult, Endpoint } from "./types.js";

export interface AssistantRequestContext {
  source?: string | undefined;
  metadata?: AssistantPromptMetadata[] | undefined;
  toolServers?: AgentToolServer[] | undefined;
}

export async function handleAssistantRequest(
  home: string,
  endpoint: Endpoint,
  message: string,
  author: string,
  context: AssistantRequestContext = {}
): Promise<AgentRunResult> {
  assertEndpointWorkspace(home, endpoint);
  const prompt = makeAssistantPrompt(message, author, context);
  const workspace = endpointWorkspace(home, endpoint);

  appendActivityLog(home, endpointActivity(home, endpoint, "message_received", { author }));
  appendActivityLog(home, endpointActivity(home, endpoint, "agent_request", { provider: endpoint.agent.provider, workspace }));

  const result = await runAgent(home, workspace, endpoint, prompt, { toolServers: context.toolServers });
  const estimatedInputTokens = estimateTokens(prompt);
  const estimatedOutputTokens = estimateTokens(result.response);
  const estimatedTokens = estimatedInputTokens + estimatedOutputTokens;
  const tokens = result.usage?.totalTokens ?? estimatedTokens;

  if (result.usage === undefined) {
    addEstimatedUsage(home, endpoint, estimatedInputTokens, estimatedOutputTokens);
  } else {
    addCodexUsage(home, endpoint, result.usage);
  }

  appendActivityLog(home, {
    ...endpointActivity(home, endpoint, "agent_response", {
      provider: endpoint.agent.provider,
      exitCode: result.exitCode,
      resumed: result.resumed,
      hasTextResponse: result.hasTextResponse,
      inputTokens: result.usage?.inputTokens ?? estimatedInputTokens,
      outputTokens: result.usage?.outputTokens ?? estimatedOutputTokens
    }),
    tokens
  });

  return result;
}
