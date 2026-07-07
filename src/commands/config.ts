import { loadConfig, type AideConfig } from "../lib/config.js";
import { printTable } from "../lib/format.js";
import type { AgentConfig } from "../lib/types.js";
import type { CommandOptions } from "./options.js";
import { homeFromOptions } from "./options.js";

export function listConfigCommand(options: CommandOptions): void {
  const config = loadConfig(homeFromOptions(options));

  console.log("Config\n");
  console.log(printTable(["Path", "Value"], configRows(config)));
}

function configRows(config: AideConfig): string[][] {
  return config.endpoints.flatMap((endpoint) => [
    [`endpoints.${endpoint.id}.token`, secretStatus(endpoint.token)],
    [`endpoints.${endpoint.id}.trigger.requireMention`, formatBoolean(endpoint.trigger.requireMention)],
    [`endpoints.${endpoint.id}.trigger.freeResponseSources`, formatList(endpoint.trigger.freeResponseSources)],
    ...agentRows(endpoint.id, endpoint.agent)
  ]);
}

function agentRows(endpointId: string, agent: AgentConfig): string[][] {
  return [
    [`endpoints.${endpointId}.agent.provider`, agent.provider],
    [`endpoints.${endpointId}.agent.command`, agent.command],
    [`endpoints.${endpointId}.agent.model`, agent.model ?? "default"],
    [`endpoints.${endpointId}.agent.reasoningEffort`, agent.reasoningEffort ?? "default"],
    [`endpoints.${endpointId}.agent.outputMode`, agent.outputMode]
  ];
}

function secretStatus(value: string): string {
  return value ? "configured" : "missing";
}

function formatBoolean(value: boolean): string {
  return String(value);
}

function formatList(value: string[]): string {
  return value.join(",");
}
