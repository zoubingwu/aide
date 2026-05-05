import fs from "node:fs";
import path from "node:path";
import prompts from "prompts";
import {
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
  endpointWorkspacePath,
  slugifyId
} from "../lib/paths.js";
import { resolveDiscordToken, writeDiscordToken } from "../lib/secrets.js";
import { inspectEndpointWorkspace, ensureEndpointWorkspace } from "../lib/workspace.js";
import type { Endpoint } from "../lib/types.js";
import type { CommandOptions } from "./options.js";
import { booleanOption, homeFromOptions, stringOption } from "./options.js";

export async function addEndpointCommand(provider: string, options: CommandOptions): Promise<void> {
  if (provider !== "discord") {
    throw new Error(`Provider ${provider} is not supported in MVP.`);
  }

  await addDiscordEndpoint(options);
}

export async function endpointCommand(args: string[] = [], options: CommandOptions): Promise<void> {
  const [command, second, third] = args;

  if (command === "add" && second) {
    await addEndpointCommand(second, options);
    return;
  }

  if (command === "list") {
    await listEndpointsCommand(options);
    return;
  }

  if (command === "show" && second) {
    await showEndpointCommand(second, options);
    return;
  }

  if (command === "pause" && second) {
    await pauseEndpointCommand(second, options);
    return;
  }

  if (command === "resume" && second) {
    await resumeEndpointCommand(second, options);
    return;
  }

  if (command === "remove" && second) {
    await removeEndpointCommand(second, options);
    return;
  }

  if (command === "test" && second) {
    await testEndpointCommand(second, options);
    return;
  }

  if (command === "open" && second) {
    await openEndpointCommand(second, options);
    return;
  }

  if (command === "config" && second === "list" && third) {
    await listEndpointConfigCommand(third, options);
    return;
  }

  if (command === "config" && second === "open" && third) {
    await openEndpointConfigCommand(third, options);
    return;
  }

  throw new Error(endpointUsage());
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
      ["ID", "Provider", "Status", "Route"],
      endpoints.map((endpoint) => [
        endpoint.id,
        endpoint.provider === "discord" ? "Discord" : endpoint.provider,
        statusLabel(endpoint.enabled),
        endpoint.routing.channel
      ])
    )
  );
}

export async function showEndpointCommand(id: string, options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const endpoint = findEndpoint(home, id);
  const workspace = inspectEndpointWorkspace(endpoint);

  console.log(`Endpoint ${endpoint.id}\n`);
  console.log(`Provider    ${endpoint.provider}`);
  console.log(`Name        ${endpoint.name}`);
  console.log(`Status      ${statusLabel(endpoint.enabled)}`);
  console.log(`Server      ${endpoint.routing.server || "-"}`);
  console.log(`Channel     ${endpoint.routing.channel || "-"}`);
  console.log(`Workspace   ${displayPath(endpoint.workspacePath)}`);
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
    fs.rmSync(endpoint.workspacePath, { recursive: true, force: true });
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
  ensureEndpointWorkspace(endpoint);
  await openPath(endpoint.workspacePath);
}

export async function listEndpointConfigCommand(id: string, options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const endpoint = findEndpoint(home, id);
  const workspace = inspectEndpointWorkspace(endpoint);

  console.log("Endpoint Config\n");
  console.log(`Endpoint    ${endpoint.id}`);
  console.log(`Path        ${displayPath(endpoint.workspacePath)}`);
  console.log("");
  console.log(`SOUL        SOUL.md      ${workspace.soulExists ? "exists" : "missing"}`);
  console.log(`AGENTS      AGENTS.md    ${workspace.agentsExists ? "exists" : "missing"}`);
}

export async function openEndpointConfigCommand(id: string, options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const endpoint = findEndpoint(home, id);
  ensureEndpointWorkspace(endpoint);
  await openFiles([
    path.join(endpoint.workspacePath, "SOUL.md"),
    path.join(endpoint.workspacePath, "AGENTS.md")
  ]);
}

async function addDiscordEndpoint(options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const endpoints = loadEndpoints(home);
  const answers = await collectDiscordEndpointAnswers(options);
  const id = slugifyId(answers.id);

  if (id.length === 0) {
    throw new Error("Endpoint name must contain at least one letter or number.");
  }

  if (endpoints.some((endpoint) => endpoint.id === id)) {
    throw new Error(`Endpoint already exists: ${id}`);
  }

  const channel = normalizeChannel(answers.channel);
  const endpoint: Endpoint = {
    id,
    provider: "discord",
    name: answers.name || `Discord ${channel}`,
    enabled: true,
    workspacePath: endpointWorkspacePath(home, id),
    routing: {
      mode: "mention_only",
      server: answers.server,
      channel
    },
    permissions: {
      requireApprovalForShell: answers.requireApprovalForShell,
      requireApprovalForWrites: answers.requireApprovalForWrites,
      restrictToEndpointWorkspace: true
    }
  };

  endpoints.push(endpoint);
  ensureEndpointWorkspace(endpoint);
  writeEndpoints(home, endpoints);

  if (answers.token) {
    const key = writeDiscordToken(home, id, answers.token);
    console.log(`Stored Discord token in ${key}.`);
  }

  console.log(`Discord endpoint ${id} created.`);
  console.log(`Workspace ${displayPath(endpoint.workspacePath)}`);
}

async function collectDiscordEndpointAnswers(options: CommandOptions): Promise<{
  id: string;
  name: string;
  token: string | undefined;
  server: string;
  channel: string;
  requireApprovalForShell: boolean;
  requireApprovalForWrites: boolean;
}> {
  const id = stringOption(options, "id");
  const name = stringOption(options, "name");
  const token = stringOption(options, "token");
  const server = stringOption(options, "server");
  const channel = stringOption(options, "channel");
  const shell = booleanOption(options, "approvalShell");
  const writes = booleanOption(options, "approvalWrites");

  if (id && channel && server) {
    return {
      id,
      name: name ?? `Discord ${normalizeChannel(channel)}`,
      token,
      server,
      channel,
      requireApprovalForShell: shell ?? true,
      requireApprovalForWrites: writes ?? true
    };
  }

  if (!process.stdin.isTTY) {
    throw new Error("Missing endpoint options. Provide --id, --server, and --channel.");
  }

  const response = await prompts([
    {
      type: id ? null : "text",
      name: "id",
      message: "Endpoint name",
      initial: "discord-agent-ops"
    },
    {
      type: name ? null : "text",
      name: "name",
      message: "Display name",
      initial: "Discord #agent-ops"
    },
    {
      type: token ? null : "password",
      name: "token",
      message: "Discord bot token"
    },
    {
      type: server ? null : "text",
      name: "server",
      message: "Server",
      initial: "agent-lab"
    },
    {
      type: channel ? null : "text",
      name: "channel",
      message: "Channel",
      initial: "#agent-ops"
    },
    {
      type: shell === undefined ? "confirm" : null,
      name: "requireApprovalForShell",
      message: "Require approval for shell commands?",
      initial: true
    },
    {
      type: writes === undefined ? "confirm" : null,
      name: "requireApprovalForWrites",
      message: "Require approval for file writes?",
      initial: true
    }
  ]);

  return {
    id: id ?? response.id,
    name: name ?? response.name,
    token: token ?? response.token,
    server: server ?? response.server,
    channel: channel ?? response.channel,
    requireApprovalForShell: shell ?? response.requireApprovalForShell,
    requireApprovalForWrites: writes ?? response.requireApprovalForWrites
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

function normalizeChannel(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

function endpointUsage(): string {
  return `Usage:
  aide endpoint add discord
  aide endpoint list
  aide endpoint show <id>
  aide endpoint pause <id>
  aide endpoint resume <id>
  aide endpoint remove <id>
  aide endpoint test <id>
  aide endpoint open <id>
  aide endpoint config list <id>
  aide endpoint config open <id>`;
}
