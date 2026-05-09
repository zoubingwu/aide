#!/usr/bin/env node
import { cac } from "cac";
import {
  addExamples,
  agentHelpCommand,
  CONFIG_EXAMPLES,
  CONFIG_PATH_LIST,
  SCHEDULE_ADD_EXAMPLES,
  SCHEDULE_KIND_LIST,
  WEEKDAY_LIST
} from "./commands/help.js";
import { homeFromOptions } from "./commands/options.js";
import packageJson from "../package.json" with { type: "json" };

const runArgv = subcommandArgv(process.argv, "__run", "aide __run");
const configArgv = subcommandArgv(process.argv, "config", "aide config");
const endpointArgv = subcommandArgv(process.argv, "endpoint", "aide endpoint");
const helpArgv = subcommandArgv(process.argv, "help", "aide help");
const importArgv = subcommandArgv(process.argv, "import", "aide import");
const scheduleArgv = subcommandArgv(process.argv, "schedule", "aide schedule");
const serviceArgv = subcommandArgv(process.argv, "service", "aide service");

if (runArgv) {
  await runInternalRuntimeCli(runArgv);
} else if (configArgv) {
  runConfigCli(configArgv);
} else if (endpointArgv) {
  const configArgv = subcommandArgv(endpointArgv, "config", "aide endpoint config");
  if (configArgv) {
    runEndpointConfigCli(configArgv);
  } else {
    runEndpointCli(endpointArgv);
  }
} else if (helpArgv) {
  runHelpCli(helpArgv);
} else if (importArgv) {
  runImportCli(importArgv);
} else if (scheduleArgv) {
  const configArgv = subcommandArgv(scheduleArgv, "config", "aide schedule config");
  if (configArgv) {
    runScheduleConfigCli(configArgv);
  } else {
    runScheduleCli(scheduleArgv);
  }
} else if (serviceArgv) {
  runServiceCli(serviceArgv);
} else {
  runRootCli(process.argv);
}

function runRootCli(argv: string[]): void {
  const cli = cac("aide");

  cli
    .option("--home <path>", "Aide home directory")
    .version(packageJson.version)
    .help();

  cli
    .command("init", "Initialize Aide and run first-time onboarding")
    .action(wrapLazy(async () => (await import("./commands/system.js")).initCommand));
  cli
    .command("start", "Start Aide runtime in the background")
    .action(wrapLazy(async () => (await import("./commands/runtime.js")).startCommand));
  cli
    .command("stop", "Stop Aide runtime")
    .action(wrapLazy(async () => (await import("./commands/runtime.js")).stopCommand));
  cli
    .command("restart", "Restart Aide runtime")
    .action(wrapLazy(async () => (await import("./commands/runtime.js")).restartCommand));
  cli
    .command("status", "Show runtime status")
    .action(wrapLazy(async () => (await import("./commands/system.js")).statusCommand));
  cli
    .command("logs", "Show logs")
    .option("--activity", "Show activity log")
    .option("--lines <count>", "Number of lines to show", { default: 80 })
    .action(wrapLazy(async () => (await import("./commands/system.js")).logsCommand));
  cli
    .command("usage", "Show usage")
    .action(wrapLazy(async () => (await import("./commands/system.js")).usageCommand));
  cli
    .command("doctor", "Validate local setup")
    .option("--fix", "Create missing Aide base files and directories")
    .action(wrapLazy(async () => (await import("./commands/system.js")).doctorCommand));
  cli.command("config", "Manage config").action(() => runConfigCli(["node", "aide config"]));
  cli.command("endpoint", "Manage endpoints").action(() => runEndpointCli(["node", "aide endpoint"]));
  cli.command("help", "Show detailed help").action(() => runHelpCli(["node", "aide help"]));
  cli.command("import", "Import endpoints").action(() => runImportCli(["node", "aide import"]));
  cli.command("schedule", "Manage schedules").action(() => runScheduleCli(["node", "aide schedule"]));
  cli.command("service", "Manage runtime service").action(() => runServiceCli(["node", "aide service"]));

  handleNoMatch(cli, cli.parse(argv));
}

function runConfigCli(argv: string[]): void {
  const cli = cac("aide config");

  cli.option("--home <path>", "Aide home directory").help();
  addExamples(
    cli
      .command("get [path]", "Show config")
      .usage(`get [path]\n\nPaths: ${CONFIG_PATH_LIST}`)
      .action(wrapLazy(async () => (await import("./commands/config.js")).getConfigCommand)),
    CONFIG_EXAMPLES.slice(0, 2)
  );
  addExamples(
    cli
      .command("set <path> <value>", "Set config")
      .usage(`set <path> <value>\n\nPaths: ${CONFIG_PATH_LIST}`)
      .action(wrapLazy(async () => (await import("./commands/config.js")).setConfigCommand)),
    CONFIG_EXAMPLES.slice(2)
  );

  handleNoMatch(cli, cli.parse(argv));
}

function runEndpointCli(argv: string[]): void {
  const cli = cac("aide endpoint");

  cli.option("--home <path>", "Aide home directory").help();

  cli
    .command("add", "Add an endpoint")
    .option("--provider <provider>", "Endpoint provider")
    .option("--id <id>", "Endpoint id")
    .option("--token <token>", "Provider token")
    .option("--agent <provider>", "CLI agent provider")
    .option("--agent-command <command>", "CLI agent command")
    .option("--model <model>", "Agent model")
    .option("--reasoning-effort <effort>", "Codex reasoning effort")
    .action(wrapLazy(async () => (await import("./commands/endpoints.js")).addEndpointCommand));
  cli
    .command("list", "List endpoints")
    .action(wrapLazy(async () => (await import("./commands/endpoints.js")).listEndpointsCommand));
  cli
    .command("show <id>", "Show endpoint details")
    .action(wrapLazy(async () => (await import("./commands/endpoints.js")).showEndpointCommand));
  cli
    .command("pause <id>", "Pause endpoint")
    .action(wrapLazy(async () => (await import("./commands/endpoints.js")).pauseEndpointCommand));
  cli
    .command("resume <id>", "Resume endpoint")
    .action(wrapLazy(async () => (await import("./commands/endpoints.js")).resumeEndpointCommand));
  cli
    .command("remove <id>", "Remove endpoint")
    .option("--yes", "Skip confirmation")
    .option("--delete-workspace", "Delete endpoint workspace")
    .action(wrapLazy(async () => (await import("./commands/endpoints.js")).removeEndpointCommand));
  cli
    .command("test <id>", "Run a local agent request through an endpoint")
    .option("--message <message>", "Message to send")
    .action(wrapLazy(async () => (await import("./commands/endpoints.js")).testEndpointCommand));
  cli
    .command("open <id>", "Open endpoint workspace")
    .action(wrapLazy(async () => (await import("./commands/endpoints.js")).openEndpointCommand));
  cli.command("config", "Manage endpoint config").action(() => runEndpointConfigCli(["node", "aide endpoint config"]));

  try {
    handleNoMatch(cli, cli.parse(argv));
  } catch (error) {
    console.error(endpointAddUnusedArgsMessage(argv, error) ?? errorMessage(error));
    process.exitCode = 1;
  }
}

function runEndpointConfigCli(argv: string[]): void {
  const cli = cac("aide endpoint config");

  cli.option("--home <path>", "Aide home directory").help();
  cli
    .command("list <id>", "List endpoint config files")
    .action(wrapLazy(async () => (await import("./commands/endpoints.js")).listEndpointConfigCommand));
  cli
    .command("open <id>", "Open endpoint config files")
    .action(wrapLazy(async () => (await import("./commands/endpoints.js")).openEndpointConfigCommand));

  handleNoMatch(cli, cli.parse(argv));
}

function runScheduleCli(argv: string[]): void {
  const cli = cac("aide schedule");

  cli.option("--home <path>", "Aide home directory").help();
  addExamples(
    cli
      .command("add <prompt>", "Add a schedule")
      .usage(`add <prompt> --id <id> --kind <kind> --endpoint <id> --target <target> [options]

Kinds: ${SCHEDULE_KIND_LIST}
Cron: 5 fields, minute hour day-of-month month day-of-week
Weekdays: ${WEEKDAY_LIST}
Targets: channel:<id> or user:<id>`)
      .option("--id <id>", "Schedule id")
      .option("--kind <kind>", `Schedule kind: ${SCHEDULE_KIND_LIST}`)
      .option("--cron <expression>", "5-field cron expression")
      .option("--endpoint <id>", "Endpoint id")
      .option("--target <target>", "Delivery target: channel:<id> or user:<id>")
      .option("--timezone <timezone>", "IANA timezone")
      .option("--time <HH:mm>", "Local time")
      .option("--weekday <weekday>", `Weekday: ${WEEKDAY_LIST}`)
      .option("--start-date <date>", "Biweekly start date")
      .option("--run-at <timestamp>", "One-shot run time")
      .option("--minute <minute>", "Minute for hourly schedules")
      .option("--day <day>", "Day of month")
      .action(wrapLazy(async () => (await import("./commands/schedules.js")).addScheduleCommand)),
    SCHEDULE_ADD_EXAMPLES
  );
  cli
    .command("list", "List schedules")
    .action(wrapLazy(async () => (await import("./commands/schedules.js")).listSchedulesCommand));
  cli
    .command("show", "Show schedule details")
    .option("--id <id>", "Schedule id")
    .action(wrapLazy(async () => (await import("./commands/schedules.js")).showScheduleCommand));
  cli
    .command("pause", "Pause schedule")
    .option("--id <id>", "Schedule id")
    .action(wrapLazy(async () => (await import("./commands/schedules.js")).pauseScheduleCommand));
  cli
    .command("resume", "Resume schedule")
    .option("--id <id>", "Schedule id")
    .action(wrapLazy(async () => (await import("./commands/schedules.js")).resumeScheduleCommand));
  cli
    .command("remove", "Remove schedule")
    .option("--id <id>", "Schedule id")
    .action(wrapLazy(async () => (await import("./commands/schedules.js")).removeScheduleCommand));
  cli.command("config", "Manage schedule config").action(() => runScheduleConfigCli(["node", "aide schedule config"]));

  handleNoMatch(cli, cli.parse(argv));
}

function runHelpCli(argv: string[]): void {
  const cli = cac("aide help");

  cli.help();
  cli.command("agent", "Show agent-facing CLI guide").action(wrap(agentHelpCommand));

  handleNoMatch(cli, cli.parse(argv));
}

function runImportCli(argv: string[]): void {
  const cli = cac("aide import");

  cli.option("--home <path>", "Aide home directory").help();
  cli
    .command("<source>", "Import endpoints from hermes, openclaw, or all")
    .action(wrapLazy(async () => (await import("./commands/import.js")).importCommand));

  handleNoMatch(cli, cli.parse(argv));
}

function runScheduleConfigCli(argv: string[]): void {
  const cli = cac("aide schedule config");

  cli.option("--home <path>", "Aide home directory").help();
  cli
    .command("open", "Open schedules config")
    .action(wrapLazy(async () => (await import("./commands/schedules.js")).openScheduleConfigCommand));

  handleNoMatch(cli, cli.parse(argv));
}

function runServiceCli(argv: string[]): void {
  const cli = cac("aide service");

  cli.option("--home <path>", "Aide home directory").help();
  cli
    .command("install", "Install runtime service")
    .action(wrapLazy(async () => (await import("./commands/service.js")).installServiceCommand));
  cli
    .command("uninstall", "Uninstall runtime service")
    .action(wrapLazy(async () => (await import("./commands/service.js")).uninstallServiceCommand));
  cli
    .command("status", "Show service status")
    .action(wrapLazy(async () => (await import("./commands/service.js")).statusServiceCommand));

  handleNoMatch(cli, cli.parse(argv));
}

async function runInternalRuntimeCli(argv: string[]): Promise<void> {
  const cli = cac("aide __run");
  cli.option("--home <path>", "Aide home directory");
  const parsed = cli.parse(argv, { run: false });
  const home = homeFromOptions(parsed.options);
  const { appendRuntimeLog } = await import("./lib/logging.js");

  try {
    const { runCommand } = await import("./commands/runtime.js");
    appendRuntimeLog(home, "runtime_internal_starting", { pid: process.pid });
    await runCommand(parsed.options);
  } catch (error) {
    appendRuntimeLog(home, "runtime_internal_error", {
      pid: process.pid,
      error: errorMessage(error),
      stack: errorStack(error)
    });
    throw error;
  }
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

function endpointAddUnusedArgsMessage(argv: string[], error: unknown): string | undefined {
  const message = errorMessage(error);

  if (!message.startsWith("Unused args:")) {
    return undefined;
  }

  const args = argv.slice(2);
  const commandIndex = firstPositionalIndex(args);

  if (commandIndex === undefined || args[commandIndex] !== "add") {
    return undefined;
  }

  const argument = firstBacktickValue(message);

  if (!argument) {
    return "Unexpected endpoint add argument. Use --provider <provider> for scripted setup, or run `aide endpoint add`.";
  }

  return `Unexpected endpoint provider argument: ${argument}. Use --provider ${argument} for scripted setup, or run \`aide endpoint add\`.`;
}

function firstBacktickValue(value: string): string | undefined {
  return value.match(/`([^`]+)`/)?.[1];
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

function wrapLazy<T extends unknown[]>(loadHandler: () => Promise<(...args: T) => Promise<void> | void>) {
  return wrap(async (...args: T) => {
    const handler = await loadHandler();
    await handler(...args);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}
