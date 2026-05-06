import { displayPath } from "../lib/paths.js";
import { installService, serviceFilePath, serviceStatus, uninstallService } from "../lib/service.js";
import type { CommandOptions } from "./options.js";
import { homeFromOptions } from "./options.js";

export async function installServiceCommand(options: CommandOptions): Promise<void> {
  const home = homeFromOptions(options);
  await installService(home);
  console.log(`Aide service installed at ${displayPath(serviceFilePath())}.`);
}

export async function uninstallServiceCommand(): Promise<void> {
  await uninstallService();
  console.log("Aide service uninstalled.");
}

export async function statusServiceCommand(): Promise<void> {
  console.log(`Service ${await serviceStatus()}`);
}
