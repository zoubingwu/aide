import { runCodex, makeAssistantPrompt, type CodexRunResult } from "./codex.js";
import { loadConfig } from "./config.js";
import { appendActivityLog, endpointActivity } from "./logging.js";
import { estimateTokens, addEstimatedUsage } from "./usage.js";
import { assertEndpointWorkspace } from "./workspace.js";
import type { Endpoint } from "./types.js";

export async function handleAssistantRequest(
  home: string,
  endpoint: Endpoint,
  message: string,
  author: string
): Promise<CodexRunResult> {
  assertEndpointWorkspace(endpoint);
  const config = loadConfig(home);
  const prompt = makeAssistantPrompt(endpoint, message, author);

  appendActivityLog(home, endpointActivity(endpoint, "message_received", { author }));
  appendActivityLog(home, endpointActivity(endpoint, "codex_request", { workspace: endpoint.workspacePath }));

  const result = await runCodex(config, endpoint, prompt);
  const tokens = estimateTokens(prompt) + estimateTokens(result.response);

  addEstimatedUsage(home, endpoint, tokens);
  appendActivityLog(home, {
    ...endpointActivity(endpoint, "codex_response", {
      exitCode: result.exitCode,
      resumed: result.resumed
    }),
    tokens
  });

  return result;
}
