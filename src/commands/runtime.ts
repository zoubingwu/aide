import { startRuntime, startRuntimeInBackground, stopRuntime } from "../lib/runtime.js";
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
  stopRuntime(home);
  await startRuntimeInBackground(home);
}
