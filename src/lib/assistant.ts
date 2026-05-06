import { makeAssistantPrompt, runAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { appendActivityLog, endpointActivity } from "./logging.js";
import { estimateTokens, addEstimatedUsage } from "./usage.js";
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
  const config = loadConfig(home);
  const prompt = makeAssistantPrompt(endpoint, message, author, context);
  const workspace = endpointWorkspace(home, endpoint);

  appendActivityLog(home, endpointActivity(home, endpoint, "message_received", { author }));
  appendActivityLog(home, endpointActivity(home, endpoint, "agent_request", { provider: config.runtime.provider, workspace }));

  const result = await runAgent(config, workspace, endpoint, prompt);
  const tokens = estimateTokens(prompt) + estimateTokens(result.response);

  addEstimatedUsage(home, endpoint, tokens);
  appendActivityLog(home, {
    ...endpointActivity(home, endpoint, "agent_response", {
      provider: config.runtime.provider,
      exitCode: result.exitCode,
      resumed: result.resumed
    }),
    tokens
  });

  return result;
}
