import fs from "node:fs";
import path from "node:path";
import prompts from "prompts";
import {
  defaultCodexAgentConfig,
  findEndpoint,
  loadEndpoints,
  requireEndpointIndex,
  writeEndpoints
} from "../lib/config.js";
import { handleAssistantRequest } from "../lib/assistant.js";
import { printTable, statusLabel } from "../lib/format.js";
import { openFiles, openPath } from "../lib/open.js";
import {
  displayPath,
  slugifyId
} from "../lib/paths.js";
import { resolveDiscordToken, writeDiscordToken } from "../lib/secrets.js";
import { inspectEndpointWorkspace, ensureEndpointWorkspace, endpointWorkspace } from "../lib/workspace.js";
import type { CodexAgentConfig, CodexReasoningEffort, Endpoint } from "../lib/types.js";
import type { CommandOptions } from "./options.js";
import { homeFromOptions, stringOption } from "./options.js";

const DEFAULT_DISCORD_ENDPOINT_ID = "discord";
const REASONING_EFFORTS: CodexReasoningEffort[] = ["low", "medium", "high", "xhigh"];

export async function addEndpointCommand(provider: string, options: CommandOptions): Promise<void> {
  if (provider !== "discord") {
    throw new Error(`Provider ${provider} is not supported in MVP.`);
  }

  await addDiscordEndpoint(options);
}

export async function listEndpointsCommand(options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const endpoints = loadEndpoints(home);

  console.log("Endpoints\n");

  if (endpoints.length === 0) {
    console.log("No endpoints configured.");
    return;
  }

  console.log(
    printTable(
      ["ID", "Provider", "Agent", "Status"],
      endpoints.map((endpoint) => [
        endpoint.id,
        endpoint.provider === "discord" ? "Discord" : endpoint.provider,
        endpoint.agent.provider,
        statusLabel(endpoint.enabled)
      ])
    )
  );
}

export async function showEndpointCommand(id: string, options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const endpoint = findEndpoint(home, id);
  const workspace = inspectEndpointWorkspace(home, endpoint);

  console.log(`Endpoint ${endpoint.id}\n`);
  console.log(`Provider    ${endpoint.provider}`);
  console.log(`Status      ${statusLabel(endpoint.enabled)}`);
  console.log(`Agent       ${endpoint.agent.provider}`);
  console.log(`Command     ${endpoint.agent.command}`);
  console.log(`Model       ${endpoint.agent.model}`);
  console.log(`Reasoning   ${endpoint.agent.reasoningEffort}`);
  console.log(`Workspace   ${displayPath(workspace.path)}`);
  console.log(`SOUL.md     ${workspace.soulExists ? "exists" : "missing"}`);
  console.log(`AGENTS.md   ${workspace.agentsExists ? "exists" : "missing"}`);
  console.log(`Token       ${resolveDiscordToken(home, endpoint) ? "configured" : "missing"}`);
}

export async function pauseEndpointCommand(id: string, options: CommandOptions): Promise<void> {
  await setEndpointEnabled(id, options, false);
}

export async function resumeEndpointCommand(id: string, options: CommandOptions): Promise<void> {
  await setEndpointEnabled(id, options, true);
}

export async function removeEndpointCommand(id: string, options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const endpoints = loadEndpoints(home);
  const index = requireEndpointIndex(endpoints, id);
  const endpoint = endpoints[index];

  if (!options.yes) {
    const response = await prompts({
      type: "confirm",
      name: "confirmed",
      message: `Remove endpoint ${id}?`,
      initial: false
    });

    if (!response.confirmed) {
      console.log("Endpoint removal cancelled.");
      return;
    }
  }

  endpoints.splice(index, 1);
  writeEndpoints(home, endpoints);

  if (options.deleteWorkspace && endpoint) {
    fs.rmSync(endpointWorkspace(home, endpoint), { recursive: true, force: true });
  }

  console.log(`Removed endpoint ${id}.`);
}

export async function testEndpointCommand(id: string, options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const endpoint = findEndpoint(home, id);
  const message = stringOption(options, "message") ?? "Reply with a short Aide endpoint health check.";
  const result = await handleAssistantRequest(home, endpoint, message, "local-cli");

  console.log(result.response);
}

export async function openEndpointCommand(id: string, options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const endpoint = findEndpoint(home, id);
  ensureEndpointWorkspace(home, endpoint);
  await openPath(endpointWorkspace(home, endpoint));
}

export async function listEndpointConfigCommand(id: string, options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const endpoint = findEndpoint(home, id);
  const workspace = inspectEndpointWorkspace(home, endpoint);

  console.log("Endpoint Config\n");
  console.log(`Endpoint    ${endpoint.id}`);
  console.log(`Path        ${displayPath(workspace.path)}`);
  console.log("");
  console.log(`SOUL        SOUL.md      ${workspace.soulExists ? "exists" : "missing"}`);
  console.log(`AGENTS      AGENTS.md    ${workspace.agentsExists ? "exists" : "missing"}`);
}

export async function openEndpointConfigCommand(id: string, options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const endpoint = findEndpoint(home, id);
  const workspacePath = endpointWorkspace(home, endpoint);
  ensureEndpointWorkspace(home, endpoint);
  await openFiles([
    path.join(workspacePath, "SOUL.md"),
    path.join(workspacePath, "AGENTS.md")
  ]);
}

async function addDiscordEndpoint(options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const endpoints = loadEndpoints(home);
  const answers = await collectDiscordEndpointAnswers(options);
  const id = slugifyId(answers.id);
  const agent = codexAgentFromOptions(options);

  if (id.length === 0) {
    throw new Error("Endpoint id must contain at least one letter or number.");
  }

  if (endpoints.some((endpoint) => endpoint.id === id)) {
    throw new Error(`Endpoint already exists: ${id}. Use --id <id> for another Discord endpoint.`);
  }

  const endpoint: Endpoint = {
    id,
    provider: "discord",
    enabled: true,
    agent
  };

  endpoints.push(endpoint);
  ensureEndpointWorkspace(home, endpoint);
  writeEndpoints(home, endpoints);

  if (answers.token) {
    const key = writeDiscordToken(home, id, answers.token);
    console.log(`Stored Discord token in ${key}.`);
  }

  console.log(`Discord endpoint ${id} created.`);
  console.log(`Workspace ${displayPath(endpointWorkspace(home, endpoint))}`);
  console.log("");
  console.log(nextStepsGuide());
}

function codexAgentFromOptions(options: CommandOptions): CodexAgentConfig {
  const provider = stringOption(options, "agent") ?? "codex";

  if (provider !== "codex") {
    throw new Error(`Agent provider ${provider} is not supported yet.`);
  }

  const defaults = defaultCodexAgentConfig();
  return {
    provider: "codex",
    command: stringOption(options, "agentCommand") ?? defaults.command,
    model: stringOption(options, "model") ?? defaults.model,
    reasoningEffort: parseReasoningEffort(stringOption(options, "reasoningEffort") ?? defaults.reasoningEffort)
  };
}

function parseReasoningEffort(value: string): CodexReasoningEffort {
  if (REASONING_EFFORTS.includes(value as CodexReasoningEffort)) {
    return value as CodexReasoningEffort;
  }

  throw new Error(`Codex reasoning effort must be one of: ${REASONING_EFFORTS.join(", ")}.`);
}

async function collectDiscordEndpointAnswers(options: CommandOptions): Promise<{
  id: string;
  token: string | undefined;
}> {
  const id = stringOption(options, "id");
  const token = stringOption(options, "token");
  const envToken = process.env.DISCORD_BOT_TOKEN;
  const needsPrompt = process.stdin.isTTY && (!id || (!token && !envToken));

  if (!process.stdin.isTTY) {
    if (!id) {
      throw new Error("Missing endpoint id. Provide --id <id>.");
    }

    if (!token && !envToken) {
      throw new Error("Missing Discord bot token. Provide --token or set DISCORD_BOT_TOKEN.");
    }

    return {
      id,
      token: token ?? envToken
    };
  }

  if (needsPrompt) {
    console.log(discordPreparationGuide());
    console.log("");
  }

  const response = await prompts([
    {
      type: id ? null : "text",
      name: "id",
      message: "Endpoint id",
      initial: DEFAULT_DISCORD_ENDPOINT_ID
    },
    {
      type: token || envToken ? null : "password",
      name: "token",
      message: "Discord bot token"
    }
  ]);

  const resolvedId = (id ?? String(response.id ?? "").trim()) || DEFAULT_DISCORD_ENDPOINT_ID;
  const resolvedToken = token ?? envToken ?? response.token;

  if (!resolvedToken) {
    throw new Error("Discord bot token is required.");
  }

  return {
    id: resolvedId,
    token: resolvedToken
  };
}

async function setEndpointEnabled(id: string, options: CommandOptions, enabled: boolean): Promise<void> {
  const home = homeFromOptions(options);
  const endpoints = loadEndpoints(home);
  const index = requireEndpointIndex(endpoints, id);
  const endpoint = endpoints[index];

  if (!endpoint) {
    throw new Error(`Endpoint not found: ${id}`);
  }

  endpoints[index] = {
    ...endpoint,
    enabled
  };
  writeEndpoints(home, endpoints);
  console.log(`${enabled ? "Resumed" : "Paused"} endpoint ${id}.`);
}

function discordPreparationGuide(): string {
  return `Discord setup before continuing:
1. Open Discord Developer Portal: https://discord.com/developers/applications
2. Create or open an app, then copy the bot token from the Bot page.
3. Install the app to a server with the bot scope: https://docs.discord.com/developers/quick-start/getting-started#adding-scopes-and-bot-permissions
4. Grant View Channel and Send Messages in target channels: https://docs.discord.com/developers/topics/permissions

Aide will ask for:
- Endpoint id: used for the workspace path and token env key.
- Discord bot token: stored in ~/.aide/.env.local.
`;
}

function nextStepsGuide(): string {
  return `Next Aide steps:
1. Run \`aide start\`.
2. Mention the bot in a Discord channel where it has access.
3. Use \`aide status\` and \`aide logs\` to inspect runtime activity.
`;
}
