import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import { agentProviderLabel } from "../lib/agent.js";
import {
  configPath,
  displayPath,
  endpointsPath,
  logsDir,
  runtimePath,
  usagePath,
  workspaceDir
} from "../lib/paths.js";
import { ensureAideHome, loadConfig, loadEndpoints, loadRuntimeState } from "../lib/config.js";
import { checkMark, printTable, statusLabel } from "../lib/format.js";
import { ACTIVITY_LOG_FILE, RUNTIME_LOG_FILE, readLastLines } from "../lib/logging.js";
import { runtimeDisplayStatus, isPidAlive } from "../lib/runtime-state.js";
import { resolveDiscordToken } from "../lib/secrets.js";
import { formatTokenCount, summarizeUsage } from "../lib/usage.js";
import { inspectEndpointWorkspace } from "../lib/workspace.js";
import type { CommandOptions } from "./options.js";
import { homeFromOptions } from "./options.js";
import type { AgentProvider, DoctorCheck } from "../lib/types.js";

export async function initCommand(options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  ensureAideHome(home);
  console.log(`Aide initialized at ${displayPath(home)}`);
}

export async function statusCommand(options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const config = loadConfig(home);
  const endpoints = loadEndpoints(home);
  const runtime = runtimeDisplayStatus(home);
  const usage = summarizeUsage(home);
  const agentLabel = agentProviderLabel(config.runtime.provider);
  const agentVersion = await readAgentVersion(config.runtime.command);

  console.log("Aide\n");
  console.log(`Home        ${displayPath(home)}`);
  console.log(`Runtime     ${runtime.status}`);

  if (runtime.pid) {
    console.log(`PID         ${runtime.pid}`);
  }

  console.log(`Agent       ${agentLabel} (${agentVersion})`);
  console.log("\nEndpoints");

  if (endpoints.length === 0) {
    console.log("No endpoints configured.");
  } else {
    const rows = endpoints.map((endpoint) => [
      endpoint.id,
      endpoint.provider === "discord" ? "Discord" : endpoint.provider,
      statusLabel(endpoint.enabled)
    ]);
    console.log(printTable(["Endpoint", "Provider", "Status"], rows));
  }

  console.log("\nTokens");
  console.log(`Today       ${formatTokenCount(usage.today)}`);
  console.log(`Total       ${formatTokenCount(usage.total)}`);
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

export async function tokensCommand(options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const usage = summarizeUsage(home);

  console.log("Token Usage\n");
  console.log(`Today        ${formatTokenCount(usage.today)}`);
  console.log(`Total        ${formatTokenCount(usage.total)}`);
  console.log(`Source       ${usage.source}`);

  if (usage.byEndpoint.length > 0) {
    console.log("\nBy Endpoint");
    console.log(printTable(["Endpoint", "Tokens"], usage.byEndpoint.map((entry) => [entry.endpoint, formatTokenCount(entry.tokens)])));
  }
}

export async function doctorCommand(options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const checks = await runDoctorChecks(home);

  console.log("Aide Doctor\n");

  for (const check of checks) {
    const detail = check.detail ? ` - ${check.detail}` : "";
    console.log(`${checkMark(check.status)} ${check.label}${detail}`);
  }
}

async function runDoctorChecks(home: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const homeExists = fs.existsSync(home);
  checks.push({
    status: homeExists ? "ok" : "fail",
    label: "Aide home",
    detail: displayPath(home)
  });

  const configExists = fs.existsSync(configPath(home));
  const endpointsExists = fs.existsSync(endpointsPath(home));
  checks.push({ status: configExists ? "ok" : "fail", label: "config.toml" });
  checks.push({ status: endpointsExists ? "ok" : "fail", label: "endpoints.toml" });
  checks.push({ status: fs.existsSync(runtimePath(home)) ? "ok" : "fail", label: "runtime.json" });
  checks.push({ status: fs.existsSync(usagePath(home)) ? "ok" : "fail", label: "usage.jsonl" });
  checks.push({ status: fs.existsSync(workspaceDir(home)) ? "ok" : "fail", label: "workspace directory" });

  const config = configExists && endpointsExists ? loadConfig(home) : undefined;
  const agentProvider = config?.runtime.provider ?? "codex";
  const agentCommand = config?.runtime.command ?? "codex";
  checks.push(await agentCheck(agentProvider, agentCommand));

  if (configExists && endpointsExists) {
    const endpoints = loadEndpoints(home);

    for (const endpoint of endpoints) {
      const workspace = inspectEndpointWorkspace(home, endpoint);
      checks.push({
        status: workspace.exists ? "ok" : "fail",
        label: `${endpoint.id} workspace`,
        detail: displayPath(workspace.path)
      });
      checks.push({ status: workspace.soulExists ? "ok" : "fail", label: `${endpoint.id} SOUL.md` });
      checks.push({ status: workspace.agentsExists ? "ok" : "fail", label: `${endpoint.id} AGENTS.md` });

      if (endpoint.provider === "discord" && endpoint.enabled) {
        checks.push({
          status: resolveDiscordToken(home, endpoint) ? "ok" : "fail",
          label: `${endpoint.id} Discord token`
        });
      }
    }

    const runtime = loadRuntimeState(home);

    if (runtime.status === "running") {
      checks.push({
        status: isPidAlive(runtime.pid) ? "ok" : "fail",
        label: "runtime PID",
        detail: runtime.pid ? String(runtime.pid) : "missing"
      });
    }

    checks.push({ status: "warn", label: "token usage", detail: "estimated" });
  }

  return checks;
}

async function agentCheck(provider: AgentProvider, command: string): Promise<DoctorCheck> {
  const label = `${agentProviderLabel(provider)} CLI`;
  const result = await execa(command, ["--version"], { reject: false });

  if (result.exitCode === 0) {
    return { status: "ok", label, detail: result.stdout.trim() };
  }

  return {
    status: "fail",
    label,
    detail: `Install ${agentProviderLabel(provider)} and run \`aide doctor\` again.`
  };
}

async function readAgentVersion(command: string): Promise<string> {
  const result = await execa(command, ["--version"], { reject: false });
  return result.exitCode === 0 ? result.stdout.trim() : "missing";
}
