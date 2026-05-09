import prompts from "prompts";
import { addEndpointCommand } from "./endpoints.js";
import { runEndpointImport } from "./import.js";
import { loadEndpoints } from "../lib/config.js";
import { runDoctorChecks } from "../lib/doctor.js";
import { detectInstalledAgents, type InstalledAgent } from "../lib/agents.js";
import { checkMark } from "../lib/format.js";
import { startRuntimeInBackground, stopRuntime } from "../lib/runtime.js";
import { runtimeDisplayStatus } from "../lib/runtime-state.js";
import type { DoctorCheck } from "../lib/types.js";

export async function runInitOnboarding(home: string): Promise<void> {
  const installedAgents = await detectInstalledAgents();
  printAgentStatus(installedAgents);

  const importedCount = await importKnownEndpoints(home);

  if (loadEndpoints(home).length === 0) {
    await createFirstEndpoint(home, installedAgents);
  }

  const checks = await printDoctorSummary(home);
  await promptRuntimeStart(home, checks, importedCount);
}

function printAgentStatus(installedAgents: InstalledAgent[]): void {
  console.log("\nCLI agents");

  if (installedAgents.length === 0) {
    console.log("Supported CLI agent needed: install Codex CLI, authenticate it, then run `aide init` again.");
    return;
  }

  for (const agent of installedAgents) {
    console.log(`- ${agent.label}: ${agent.version ?? agent.command}`);
  }
}

async function importKnownEndpoints(home: string): Promise<number> {
  console.log("\nExisting endpoint discovery");
  let importedCount = 0;

  for (const source of ["hermes", "openclaw"] as const) {
    try {
      const result = await runEndpointImport(home, source, { promptRuntime: false });
      importedCount += result.importedCount;
    } catch (error) {
      console.log(`${source} import discovery skipped: ${errorMessage(error)}.`);
    }
  }

  return importedCount;
}

async function createFirstEndpoint(home: string, installedAgents: InstalledAgent[]): Promise<void> {
  if (installedAgents.length === 0) {
    console.log("\nEndpoint setup needs a supported CLI agent.");
    return;
  }

  console.log("\nEndpoint setup");

  try {
    await addEndpointCommand({ home });
  } catch (error) {
    console.log(`Endpoint setup skipped: ${errorMessage(error)}.`);
  }
}

async function printDoctorSummary(home: string): Promise<DoctorCheck[]> {
  const checks = await runDoctorChecks(home);

  console.log("\nAide Doctor\n");

  for (const check of checks) {
    const detail = check.detail ? ` - ${check.detail}` : "";
    console.log(`${checkMark(check.status)} ${check.label}${detail}`);
  }

  return checks;
}

async function promptRuntimeStart(home: string, checks: DoctorCheck[], importedCount: number): Promise<void> {
  const endpoints = loadEndpoints(home).filter((endpoint) => endpoint.enabled);
  const runtime = runtimeDisplayStatus(home);
  const failedChecks = blockingDoctorFailures(checks, runtime.status);

  if (runtime.status === "running") {
    if (importedCount === 0) {
      console.log(`\nAide runtime is running with PID ${runtime.pid}.`);
      return;
    }

    if (failedChecks.length > 0) {
      console.log("\nRuntime restart needs passing doctor checks.");
      return;
    }

    await promptRuntimeRestart(home);
    return;
  }

  if (endpoints.length === 0) {
    console.log("\nRuntime start needs an enabled endpoint.");
    return;
  }

  if (failedChecks.length > 0) {
    console.log("\nRuntime start needs passing doctor checks.");
    return;
  }

  const response = await prompts({
    type: "confirm",
    name: "confirmed",
    message: "Start Aide now?",
    initial: true
  });

  if (!response.confirmed) {
    console.log("\nRun `aide start` when ready.");
    return;
  }

  await startRuntimeInBackground(home);
}

async function promptRuntimeRestart(home: string): Promise<void> {
  const response = await prompts({
    type: "confirm",
    name: "confirmed",
    message: "Restart Aide now to use imported endpoints?",
    initial: true
  });

  if (!response.confirmed) {
    console.log("\nRun `aide restart` to use imported endpoints.");
    return;
  }

  stopRuntime(home);
  await startRuntimeInBackground(home);
}

function blockingDoctorFailures(
  checks: DoctorCheck[],
  runtimeStatus: ReturnType<typeof runtimeDisplayStatus>["status"]
): DoctorCheck[] {
  return checks.filter((check) => check.status === "fail" && isBlockingDoctorFailure(check, runtimeStatus));
}

function isBlockingDoctorFailure(
  check: DoctorCheck,
  runtimeStatus: ReturnType<typeof runtimeDisplayStatus>["status"]
): boolean {
  return check.label !== "runtime PID" || runtimeStatus === "running";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
