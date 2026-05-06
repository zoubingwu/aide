import { runCodex, makeAssistantPrompt, type CodexRunResult } from "./codex.js";
import { loadConfig } from "./config.js";
import { appendActivityLog, endpointActivity } from "./logging.js";
import { estimateTokens, addEstimatedUsage } from "./usage.js";
import { assertEndpointWorkspace, endpointWorkspace } from "./workspace.js";
import type { Endpoint } from "./types.js";

export async function handleAssistantRequest(
  home: string,
  endpoint: Endpoint,
  message: string,
  author: string
): Promise<CodexRunResult> {
  assertEndpointWorkspace(home, endpoint);
  const config = loadConfig(home);
  const prompt = makeAssistantPrompt(endpoint, message, author);
  const workspace = endpointWorkspace(home, endpoint);

  appendActivityLog(home, endpointActivity(home, endpoint, "message_received", { author }));
  appendActivityLog(home, endpointActivity(home, endpoint, "codex_request", { workspace }));

  const result = await runCodex(config, workspace, endpoint, prompt);
  const tokens = estimateTokens(prompt) + estimateTokens(result.response);

  addEstimatedUsage(home, endpoint, tokens);
  appendActivityLog(home, {
    ...endpointActivity(home, endpoint, "codex_response", {
      exitCode: result.exitCode,
      resumed: result.resumed
    }),
    tokens
  });

  return result;
}
