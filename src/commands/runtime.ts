import { startRuntime, startRuntimeInBackground, stopRuntime } from "../lib/runtime.js";
import { deferredRuntimeRestartId, requestDeferredRuntimeRestart } from "../lib/runtime-restart.js";
import type { CommandOptions } from "./options.js";
import { homeFromOptions } from "./options.js";

export async function startCommand(options: CommandOptions): Promise<void> {
  await startRuntimeInBackground(homeFromOptions(options));
}

export async function runCommand(options: CommandOptions): Promise<void> {
  await startRuntime(homeFromOptions(options));
}

export async function stopCommand(options: CommandOptions): Promise<void> {
  stopRuntime(homeFromOptions(options));
}

export async function restartCommand(options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  const deferredRestartId = deferredRuntimeRestartId(home);

  if (deferredRestartId) {
    requestDeferredRuntimeRestart(home, deferredRestartId);
    console.log("Aide runtime restart queued after the active agent response is delivered.");
    return;
  }

  stopRuntime(home);
  await startRuntimeInBackground(home);
}
