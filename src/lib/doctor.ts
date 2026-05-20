import fs from "node:fs";
import { execa } from "execa";
import { agentProviderLabel } from "./agent.js";
import { ensureAideHome, loadEndpoints, loadRuntimeState } from "./config.js";
import {
  configPath,
  displayPath,
  logsDir,
  pendingDeliveriesPath,
  runtimePath,
  scheduleCheckpointsPath,
  schedulesPath,
  stateDir,
  usagePath,
  workspaceDir
} from "./paths.js";
import { isPidAlive } from "./runtime-state.js";
import { inspectEndpointWorkspace } from "./workspace.js";
import type { AgentProvider, DoctorCheck } from "./types.js";

export function repairBasePaths(home: string): string[] {
  const missing = missingBasePathLabels(home);
  ensureAideHome(home);
  return missing;
}

export function missingBasePathLabels(home: string): string[] {
  return [
    { label: "Aide home", path: home },
    { label: "config.toml", path: configPath(home) },
    { label: "schedules.json", path: schedulesPath(home) },
    { label: "pending-deliveries.json", path: pendingDeliveriesPath(home) },
    { label: "schedule-checkpoints.json", path: scheduleCheckpointsPath(home) },
    { label: "runtime.json", path: runtimePath(home) },
    { label: "usage.jsonl", path: usagePath(home) },
    { label: "logs directory", path: logsDir(home) },
    { label: "state directory", path: stateDir(home) },
    { label: "workspace directory", path: workspaceDir(home) }
  ]
    .filter((entry) => !fs.existsSync(entry.path))
    .map((entry) => entry.label);
}

export async function runDoctorChecks(home: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const homeExists = fs.existsSync(home);
  checks.push({
    status: homeExists ? "ok" : "fail",
    label: "Aide home",
    detail: displayPath(home)
  });

  const configExists = fs.existsSync(configPath(home));
  checks.push({ status: configExists ? "ok" : "fail", label: "config.toml" });
  checks.push({ status: fs.existsSync(schedulesPath(home)) ? "ok" : "fail", label: "schedules.json" });
  checks.push({ status: fs.existsSync(pendingDeliveriesPath(home)) ? "ok" : "fail", label: "pending-deliveries.json" });
  checks.push({ status: fs.existsSync(scheduleCheckpointsPath(home)) ? "ok" : "fail", label: "schedule-checkpoints.json" });
  checks.push({ status: fs.existsSync(runtimePath(home)) ? "ok" : "fail", label: "runtime.json" });
  checks.push({ status: fs.existsSync(usagePath(home)) ? "ok" : "fail", label: "usage.jsonl" });
  checks.push({ status: fs.existsSync(stateDir(home)) ? "ok" : "fail", label: "state directory" });
  checks.push({ status: fs.existsSync(workspaceDir(home)) ? "ok" : "fail", label: "workspace directory" });
  const serviceSupported = process.platform === "darwin" || process.platform === "linux";
  checks.push({
    status: serviceSupported ? "ok" : "warn",
    label: "runtime service",
    detail: serviceSupported ? process.platform : "manual start supported"
  });

  if (configExists) {
    const endpoints = loadEndpoints(home);

    for (const endpoint of endpoints) {
      checks.push(await agentCheck(endpoint.agent.provider, endpoint.agent.command, endpoint.id));
      const workspace = inspectEndpointWorkspace(home, endpoint);
      checks.push({
        status: workspace.exists ? "ok" : "fail",
        label: `${endpoint.id} workspace`,
        detail: displayPath(workspace.path),
        endpointId: endpoint.id
      });
      checks.push({
        status: workspace.soulExists ? "ok" : "fail",
        label: `${endpoint.id} SOUL.md`,
        endpointId: endpoint.id
      });
      checks.push({
        status: workspace.agentsExists ? "ok" : "fail",
        label: `${endpoint.id} AGENTS.md`,
        endpointId: endpoint.id
      });

      if (endpoint.provider === "discord" && endpoint.enabled) {
        checks.push({
          status: endpoint.token ? "ok" : "fail",
          label: `${endpoint.id} Discord token`,
          endpointId: endpoint.id
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

async function agentCheck(provider: AgentProvider, command: string, endpointId: string): Promise<DoctorCheck> {
  const label = `${endpointId} ${agentProviderLabel(provider)} CLI`;
  const result = await execa(command, ["--version"], { reject: false });

  if (result.exitCode === 0) {
    return { status: "ok", label, detail: result.stdout.trim(), endpointId };
  }

  return {
    status: "fail",
    label,
    detail: `Install ${agentProviderLabel(provider)} and run \`aide doctor\` again.`,
    endpointId
  };
}
