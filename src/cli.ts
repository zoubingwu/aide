#!/usr/bin/env node
import { cac } from "cac";
import {
  doctorCommand,
  initCommand,
  logsCommand,
  statusCommand,
  usageCommand
} from "./commands/system.js";
import {
  restartCommand,
  runCommand,
  startCommand,
  stopCommand
} from "./commands/runtime.js";
import {
  getConfigCommand,
  setConfigCommand
} from "./commands/config.js";
import {
  installServiceCommand,
  statusServiceCommand,
  uninstallServiceCommand
} from "./commands/service.js";
import {
  addScheduleCommand,
  listSchedulesCommand,
  openScheduleConfigCommand,
  pauseScheduleCommand,
  removeScheduleCommand,
  resumeScheduleCommand,
  showScheduleCommand
} from "./commands/schedules.js";
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
import {
  addExamples,
  agentHelpCommand,
  CONFIG_EXAMPLES,
  CONFIG_PATH_LIST,
  SCHEDULE_ADD_EXAMPLES,
  SCHEDULE_KIND_LIST,
  WEEKDAY_LIST
} from "./commands/help.js";
import { appendRuntimeLog } from "./lib/logging.js";
import { homeFromOptions } from "./commands/options.js";

const runArgv = subcommandArgv(process.argv, "__run", "aide __run");
const configArgv = subcommandArgv(process.argv, "config", "aide config");
const endpointArgv = subcommandArgv(process.argv, "endpoint", "aide endpoint");
const helpArgv = subcommandArgv(process.argv, "help", "aide help");
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
    .version("0.1.0")
    .help();

  cli.command("init", "Initialize Aide home").action(wrap(initCommand));
  cli.command("start", "Start Aide runtime in the background").action(wrap(startCommand));
  cli.command("stop", "Stop Aide runtime").action(wrap(stopCommand));
  cli.command("restart", "Restart Aide runtime").action(wrap(restartCommand));
  cli.command("status", "Show runtime status").action(wrap(statusCommand));
  cli
    .command("logs", "Show logs")
    .option("--activity", "Show activity log")
    .option("--lines <count>", "Number of lines to show", { default: 80 })
    .action(wrap(logsCommand));
  cli.command("usage", "Show usage").action(wrap(usageCommand));
  cli
    .command("doctor", "Validate local setup")
    .option("--fix", "Create missing Aide base files and directories")
    .action(wrap(doctorCommand));
  cli.command("config", "Manage config").action(() => runConfigCli(["node", "aide config"]));
  cli.command("endpoint", "Manage endpoints").action(() => runEndpointCli(["node", "aide endpoint"]));
  cli.command("help", "Show detailed help").action(() => runHelpCli(["node", "aide help"]));
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
      .action(wrap(getConfigCommand)),
    CONFIG_EXAMPLES.slice(0, 2)
  );
  addExamples(
    cli
      .command("set <path> <value>", "Set config")
      .usage(`set <path> <value>\n\nPaths: ${CONFIG_PATH_LIST}`)
      .action(wrap(setConfigCommand)),
    CONFIG_EXAMPLES.slice(2)
  );

  handleNoMatch(cli, cli.parse(argv));
}

function runEndpointCli(argv: string[]): void {
  const cli = cac("aide endpoint");

  cli.option("--home <path>", "Aide home directory").help();

  cli
    .command("add <provider>", "Add an endpoint")
    .option("--id <id>", "Endpoint id")
    .option("--token <token>", "Provider token")
    .option("--agent <provider>", "CLI agent provider")
    .option("--agent-command <command>", "CLI agent command")
    .option("--model <model>", "Agent model")
    .option("--reasoning-effort <effort>", "Codex reasoning effort")
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
    .command("test <id>", "Run a local agent request through an endpoint")
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
      .action(wrap(addScheduleCommand)),
    SCHEDULE_ADD_EXAMPLES
  );
  cli.command("list", "List schedules").action(wrap(listSchedulesCommand));
  cli.command("show", "Show schedule details").option("--id <id>", "Schedule id").action(wrap(showScheduleCommand));
  cli.command("pause", "Pause schedule").option("--id <id>", "Schedule id").action(wrap(pauseScheduleCommand));
  cli.command("resume", "Resume schedule").option("--id <id>", "Schedule id").action(wrap(resumeScheduleCommand));
  cli.command("remove", "Remove schedule").option("--id <id>", "Schedule id").action(wrap(removeScheduleCommand));
  cli.command("config", "Manage schedule config").action(() => runScheduleConfigCli(["node", "aide schedule config"]));

  handleNoMatch(cli, cli.parse(argv));
}

function runHelpCli(argv: string[]): void {
  const cli = cac("aide help");

  cli.help();
  cli.command("agent", "Show agent-facing CLI guide").action(wrap(agentHelpCommand));

  handleNoMatch(cli, cli.parse(argv));
}

function runScheduleConfigCli(argv: string[]): void {
  const cli = cac("aide schedule config");

  cli.option("--home <path>", "Aide home directory").help();
  cli.command("open", "Open schedules config").action(wrap(openScheduleConfigCommand));

  handleNoMatch(cli, cli.parse(argv));
}

function runServiceCli(argv: string[]): void {
  const cli = cac("aide service");

  cli.option("--home <path>", "Aide home directory").help();
  cli.command("install", "Install runtime service").action(wrap(installServiceCommand));
  cli.command("uninstall", "Uninstall runtime service").action(wrap(uninstallServiceCommand));
  cli.command("status", "Show service status").action(wrap(statusServiceCommand));

  handleNoMatch(cli, cli.parse(argv));
}

async function runInternalRuntimeCli(argv: string[]): Promise<void> {
  const cli = cac("aide __run");
  cli.option("--home <path>", "Aide home directory");
  const parsed = cli.parse(argv, { run: false });
  const home = homeFromOptions(parsed.options);

  try {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}
