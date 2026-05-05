#!/usr/bin/env node
import { cac } from "cac";
import {
  doctorCommand,
  initCommand,
  logsCommand,
  statusCommand,
  tokensCommand
} from "./commands/system.js";
import {
  restartCommand,
  startCommand,
  stopCommand
} from "./commands/runtime.js";
import {
  endpointCommand
} from "./commands/endpoints.js";

const cli = cac("aide");

cli
  .option("--home <path>", "Aide home directory")
  .version("0.1.0")
  .help();

cli.command("init", "Initialize Aide home").action(wrap(initCommand));
cli.command("start", "Start Aide runtime").action(wrap(startCommand));
cli.command("stop", "Stop Aide runtime").action(wrap(stopCommand));
cli.command("restart", "Restart Aide runtime").action(wrap(restartCommand));
cli.command("status", "Show runtime status").action(wrap(statusCommand));
cli
  .command("logs", "Show logs")
  .option("--activity", "Show activity log")
  .option("--lines <count>", "Number of lines to show", { default: 80 })
  .action(wrap(logsCommand));
cli.command("tokens", "Show token usage").action(wrap(tokensCommand));
cli.command("doctor", "Validate local setup").action(wrap(doctorCommand));

cli
  .command("endpoint [...args]", "Manage endpoints")
  .option("--id <id>", "Endpoint id")
  .option("--name <name>", "Display name")
  .option("--token <token>", "Provider token")
  .option("--server <server>", "Discord server name or id")
  .option("--channel <channel>", "Discord channel name or id")
  .option("--approval-shell", "Require approval for shell commands")
  .option("--no-approval-shell", "Allow shell commands without endpoint approval flag")
  .option("--approval-writes", "Require approval for file writes")
  .option("--no-approval-writes", "Allow file writes without endpoint approval flag")
  .option("--yes", "Skip confirmation")
  .option("--delete-workspace", "Delete endpoint workspace")
  .option("--message <message>", "Message to send")
  .action(wrap(endpointCommand));

cli.parse();

if (process.argv.length <= 2) {
  cli.outputHelp();
}

function wrap<T extends unknown[]>(handler: (...args: T) => Promise<void> | void) {
  return async (...args: T) => {
    try {
      await handler(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    }
  };
}
