import { loadConfig, type AideConfig } from "../lib/config.js";
import { printTable } from "../lib/format.js";
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
    [`endpoints.${endpoint.id}.agent.provider`, endpoint.agent.provider],
    [`endpoints.${endpoint.id}.agent.command`, endpoint.agent.command],
    [`endpoints.${endpoint.id}.agent.model`, endpoint.agent.model],
    [`endpoints.${endpoint.id}.agent.reasoningEffort`, endpoint.agent.reasoningEffort]
  ]);
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
