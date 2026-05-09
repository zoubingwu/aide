import path from "node:path";
import { agentProviderLabel } from "../lib/agent.js";
import { displayPath, logsDir } from "../lib/paths.js";
import { ensureAideHome, loadEndpoints } from "../lib/config.js";
import { checkMark, printTable, statusLabel } from "../lib/format.js";
import { ACTIVITY_LOG_FILE, RUNTIME_LOG_FILE, readLastLines } from "../lib/logging.js";
import { runtimeDisplayStatus } from "../lib/runtime-state.js";
import { formatTokenCount, summarizeUsage } from "../lib/usage.js";
import { repairBasePaths, runDoctorChecks } from "../lib/doctor.js";
import { runInitOnboarding } from "./onboarding.js";
import type { CommandOptions } from "./options.js";
import { homeFromOptions } from "./options.js";

export async function initCommand(options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  ensureAideHome(home);
  console.log(`Aide initialized at ${displayPath(home)}`);

  if (process.stdin.isTTY) {
    await runInitOnboarding(home);
    return;
  }

  console.log("\nNext Aide steps:");
  console.log("1. Run `aide init` in an interactive terminal to complete onboarding.");
  console.log("2. Or run `aide endpoint add` and `aide start` manually.");
}

export async function statusCommand(options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const endpoints = loadEndpoints(home);
  const runtime = runtimeDisplayStatus(home);
  const usage = summarizeUsage(home);

  console.log("Aide\n");
  console.log(`Home        ${displayPath(home)}`);
  console.log(`Runtime     ${runtime.status}`);

  if (runtime.pid) {
    console.log(`PID         ${runtime.pid}`);
  }

  console.log("\nEndpoints");

  if (endpoints.length === 0) {
    console.log("No endpoints configured.");
  } else {
    const rows = endpoints.map((endpoint) => [
      endpoint.id,
      endpoint.provider === "discord" ? "Discord" : endpoint.provider,
      agentProviderLabel(endpoint.agent.provider),
      statusLabel(endpoint.enabled)
    ]);
    console.log(printTable(["Endpoint", "Provider", "Agent", "Status"], rows));
  }

  console.log("\nTokens");
  console.log(`Today       ${formatUsageTotal(usage.today, usage.todayInputTokens, usage.todayOutputTokens)}`);
  console.log(`Total       ${formatUsageTotal(usage.total, usage.totalInputTokens, usage.totalOutputTokens)}`);
  console.log(`Source      ${usage.source}`);
}

export async function logsCommand(options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const lineCount = Number(options.lines ?? 80);
  const fileName = options.activity ? ACTIVITY_LOG_FILE : RUNTIME_LOG_FILE;
  const filePath = path.join(logsDir(home), fileName);
  const lines = readLastLines(filePath, Number.isFinite(lineCount) ? lineCount : 80);

  if (lines.length === 0) {
    console.log(`No ${fileName} entries.`);
    return;
  }

  console.log(lines.join("\n"));
}

export async function usageCommand(options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const usage = summarizeUsage(home);

  console.log("Usage\n");
  console.log(`Today        ${formatUsageTotal(usage.today, usage.todayInputTokens, usage.todayOutputTokens)}`);
  console.log(`Total        ${formatUsageTotal(usage.total, usage.totalInputTokens, usage.totalOutputTokens)}`);
  console.log(`Source       ${usage.source}`);

  if (usage.byEndpoint.length > 0) {
    console.log("\nBy Endpoint");
    console.log(printTable(
      ["Endpoint", "Input", "Output", "Total"],
      usage.byEndpoint.map((entry) => [
        entry.endpoint,
        formatTokenCount(entry.inputTokens),
        formatTokenCount(entry.outputTokens),
        formatTokenCount(entry.tokens)
      ])
    ));
  }
}

function formatUsageTotal(total: number, inputTokens: number, outputTokens: number): string {
  return `${formatTokenCount(total)} (${formatTokenCount(inputTokens)} input, ${formatTokenCount(outputTokens)} output)`;
}

export async function doctorCommand(options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);

  if (options.fix === true) {
    const missing = repairBasePaths(home);
    console.log(
      missing.length > 0 ? `Fixed missing Aide base paths: ${missing.join(", ")}.\n` : "No missing Aide base paths.\n"
    );
  }

  const checks = await runDoctorChecks(home);

  console.log("Aide Doctor\n");

  for (const check of checks) {
    const detail = check.detail ? ` - ${check.detail}` : "";
    console.log(`${checkMark(check.status)} ${check.label}${detail}`);
  }
}
