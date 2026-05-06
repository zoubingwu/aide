import type { Command } from "cac";
import type { ScheduleKind, Weekday } from "../lib/types.js";

export const SCHEDULE_KINDS = ["hourly", "daily", "weekly", "biweekly", "monthly", "once"] as const satisfies readonly ScheduleKind[];
export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const satisfies readonly Weekday[];

export const CONFIG_PATHS = [
  "runtime.command",
  "runtime.args",
  "runtime.model",
  "runtime.reasoningEffort",
  "runtime.startupTimeoutMs"
] as const;

export const SCHEDULE_KIND_LIST = SCHEDULE_KINDS.join(" | ");
export const WEEKDAY_LIST = WEEKDAYS.join(" | ");
export const CONFIG_PATH_LIST = CONFIG_PATHS.join(" | ");

export const CONFIG_EXAMPLES = [
  "aide config get",
  "aide config get runtime.model",
  "aide config set runtime.model gpt-5.5",
  "aide config set runtime.reasoningEffort high",
  "aide config set runtime.args '[\"exec\",\"resume\",\"--last\",\"--json\",\"--skip-git-repo-check\"]'"
];

export const SCHEDULE_ADD_EXAMPLES = [
  'aide schedule add "Generate my daily brief." --id daily-brief --kind daily --endpoint discord --target channel:123 --time 09:00',
  'aide schedule add "Check failed jobs." --id hourly-check --kind hourly --endpoint discord --target channel:123 --minute 0',
  'aide schedule add "Weekly planning notes." --id weekly-plan --kind weekly --endpoint discord --target channel:123 --weekday monday --time 10:00',
  'aide schedule add "One-off reminder." --id launch-reminder --kind once --endpoint discord --target channel:123 --run-at 2026-05-08T09:00:00+08:00'
];

export function addExamples(command: Command, examples: string[]): Command {
  for (const example of examples) {
    command.example(example);
  }

  return command;
}

export function agentHelpCommand(): void {
  console.log(agentHelpText());
}

function agentHelpText(): string {
  return `Aide Agent Guide

Use the aide CLI when asked to inspect or change Aide settings. Prefer exact commands over editing TOML directly.

When the prompt includes Source: channel:<id> or Source: user:<id>, use that source as the default schedule --target unless the user asks for another target.

Config
- Get all runtime config: aide config get
- Get one value: aide config get <path>
- Set one value: aide config set <path> <value>
- Paths: ${CONFIG_PATH_LIST}
- runtime.args value must be a JSON array of strings.
- runtime.command, runtime.args, runtime.model, and runtime.reasoningEffort apply on the next agent request.
- runtime.startupTimeoutMs applies on the next start or restart.

Config examples
${CONFIG_EXAMPLES.map((example) => `- ${example}`).join("\n")}

Schedules
- Add: aide schedule add <prompt> --id <id> --kind <kind> --endpoint <id> --target <target> [options]
- Show: aide schedule show --id <id>
- Pause: aide schedule pause --id <id>
- Resume: aide schedule resume --id <id>
- Remove: aide schedule remove --id <id>
- Kinds: ${SCHEDULE_KIND_LIST}
- Weekdays: ${WEEKDAY_LIST}
- Targets: channel:<id> or user:<id>
- Schedule changes are reloaded by the runtime within 30 seconds.

Schedule examples
${SCHEDULE_ADD_EXAMPLES.map((example) => `- ${example}`).join("\n")}

Runtime
- Use aide restart after endpoint or token changes.
- Use aide status, aide logs, aide doctor, and aide usage to inspect the runtime.
`;
}
