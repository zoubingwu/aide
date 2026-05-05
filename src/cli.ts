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
  addEndpointCommand,
  listEndpointConfigCommand,
  listEndpointsCommand,
  openEndpointCommand,
  openEndpointConfigCommand,
  pauseEndpointCommand,
  removeEndpointCommand,
  resumeEndpointCommand,
  showEndpointCommand,
  testEndpointCommand
} from "./commands/endpoints.js";

const endpointArgv = subcommandArgv(process.argv, "endpoint", "aide endpoint");

if (endpointArgv) {
  const configArgv = subcommandArgv(endpointArgv, "config", "aide endpoint config");
  if (configArgv) {
    runEndpointConfigCli(configArgv);
  } else {
    runEndpointCli(endpointArgv);
  }
} else {
  runRootCli(process.argv);
}

function runRootCli(argv: string[]): void {
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
  cli.command("endpoint", "Manage endpoints").action(() => runEndpointCli(["node", "aide endpoint"]));

  handleNoMatch(cli, cli.parse(argv));
}

function runEndpointCli(argv: string[]): void {
  const cli = cac("aide endpoint");

  cli.option("--home <path>", "Aide home directory").help();

  cli
    .command("add <provider>", "Add an endpoint")
    .option("--id <id>", "Endpoint id")
    .option("--name <name>", "Display name")
    .option("--token <token>", "Provider token")
    .option("--server <server>", "Discord server name or id")
    .option("--channel <channel>", "Discord channel name or id")
    .option("--approval-shell", "Require approval for shell commands")
    .option("--no-approval-shell", "Allow shell commands without endpoint approval flag")
    .option("--approval-writes", "Require approval for file writes")
    .option("--no-approval-writes", "Allow file writes without endpoint approval flag")
    .action(wrap(addEndpointCommand));
  cli.command("list", "List endpoints").action(wrap(listEndpointsCommand));
  cli.command("show <id>", "Show endpoint details").action(wrap(showEndpointCommand));
  cli.command("pause <id>", "Pause endpoint").action(wrap(pauseEndpointCommand));
  cli.command("resume <id>", "Resume endpoint").action(wrap(resumeEndpointCommand));
  cli
    .command("remove <id>", "Remove endpoint")
    .option("--yes", "Skip confirmation")
    .option("--delete-workspace", "Delete endpoint workspace")
    .action(wrap(removeEndpointCommand));
  cli
    .command("test <id>", "Run a local Codex request through an endpoint")
    .option("--message <message>", "Message to send")
    .action(wrap(testEndpointCommand));
  cli.command("open <id>", "Open endpoint workspace").action(wrap(openEndpointCommand));
  cli.command("config", "Manage endpoint config").action(() => runEndpointConfigCli(["node", "aide endpoint config"]));

  handleNoMatch(cli, cli.parse(argv));
}

function runEndpointConfigCli(argv: string[]): void {
  const cli = cac("aide endpoint config");

  cli.option("--home <path>", "Aide home directory").help();
  cli.command("list <id>", "List endpoint config files").action(wrap(listEndpointConfigCommand));
  cli.command("open <id>", "Open endpoint config files").action(wrap(openEndpointConfigCommand));

  handleNoMatch(cli, cli.parse(argv));
}

function subcommandArgv(argv: string[], command: string, displayName: string): string[] | undefined {
  const args = argv.slice(2);
  const index = firstPositionalIndex(args);

  if (index === undefined || args[index] !== command) {
    return undefined;
  }

  return [argv[0] ?? "node", displayName, ...args.slice(0, index), ...args.slice(index + 1)];
}

function firstPositionalIndex(args: string[]): number | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--") {
      return undefined;
    }

    if (arg === "--home") {
      index += 1;
      continue;
    }

    if (arg?.startsWith("--home=") || arg?.startsWith("-")) {
      continue;
    }

    return index;
  }

  return undefined;
}

function handleNoMatch(cli: ReturnType<typeof cac>, parsed: { args: readonly string[]; options: Record<string, unknown> }): void {
  if (cli.matchedCommand || parsed.options.help || parsed.options.version) {
    return;
  }

  if (parsed.args.length > 0) {
    console.error(`Unknown command: ${parsed.args[0]}`);
    process.exitCode = 1;
  }

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
