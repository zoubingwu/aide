import type { Command } from "cac";
import type { ScheduleKind, Weekday } from "../lib/types.js";

export const SCHEDULE_KINDS = ["cron", "hourly", "daily", "weekly", "biweekly", "monthly", "once"] as const satisfies readonly ScheduleKind[];
export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const satisfies readonly Weekday[];

export const CONFIG_PATHS = [
  "endpoints.<id>.token",
  "endpoints.<id>.trigger.requireMention",
  "endpoints.<id>.trigger.freeResponseSources",
  "endpoints.<id>.agent.command",
  "endpoints.<id>.agent.model",
  "endpoints.<id>.agent.reasoningEffort"
] as const;

export const SCHEDULE_KIND_LIST = SCHEDULE_KINDS.join(" | ");
export const WEEKDAY_LIST = WEEKDAYS.join(" | ");
export const CONFIG_PATH_LIST = CONFIG_PATHS.join(" | ");

export const CONFIG_EXAMPLES = [
  "aide config get",
  "aide config get endpoints.discord.agent.model",
  "aide config set endpoints.discord.token <discord-bot-token>",
  "aide config set endpoints.discord.trigger.requireMention true",
  "aide config set endpoints.discord.trigger.freeResponseSources channel:123,channel:456",
  "aide config set endpoints.discord.agent.model gpt-5.5",
  "aide config set endpoints.discord.agent.reasoningEffort high"
];

export const SCHEDULE_ADD_EXAMPLES = [
  'aide schedule add "Check failed jobs." --id failed-jobs --kind cron --cron "*/15 * * * *" --endpoint discord --target channel:123 --timezone Asia/Shanghai',
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

Use the aide CLI when asked to inspect or change Aide settings. Prefer exact commands over direct config edits.

When the prompt includes Source: channel:<id> or Source: user:<id>, use that source as the default schedule --target unless the user asks for another target.

Config
- Get all config: aide config get
- Get one value: aide config get <path>
- Set one value: aide config set <path> <value>
- Paths: ${CONFIG_PATH_LIST}
- Endpoint token changes apply on the next start or restart.
- Endpoint trigger changes apply on the next start or restart.
- Endpoint agent command, model, and reasoning effort apply on the next agent request.

Trigger guide
- Trigger settings are per endpoint.
- Direct messages always trigger the endpoint.
- Server channels require a bot mention by default: endpoints.<id>.trigger.requireMention = true
- Set endpoints.<id>.trigger.requireMention false to respond to every accessible server-channel message for that endpoint.
- Set endpoints.<id>.trigger.freeResponseSources to a comma-separated channel list for mention-free channels, such as channel:123,channel:456.
- A thread whose parent channel is listed in freeResponseSources also triggers without a mention.
- Mention-free server-channel triggers require Message Content Intent in the Discord Developer Portal.
- When a user asks to make the current Discord channel mention-free, use Source: channel:<id> as the value for endpoints.<id>.trigger.freeResponseSources, then run aide restart.

Config examples
${CONFIG_EXAMPLES.map((example) => `- ${example}`).join("\n")}

Schedules
- Add: aide schedule add <prompt> --id <id> --kind <kind> --endpoint <id> --target <target> [options]
- Show: aide schedule show --id <id>
- Pause: aide schedule pause --id <id>
- Resume: aide schedule resume --id <id>
- Remove: aide schedule remove --id <id>
- Kinds: ${SCHEDULE_KIND_LIST}
- Agents should prefer --kind cron with --cron for exact schedules.
- Agents should use --kind once with --run-at for delayed reminders, relative-time reminders, and timed follow-ups.
- Cron uses 5 fields: minute hour day-of-month month day-of-week.
- High-level kinds are available for human-friendly daily, weekly, monthly, and one-shot schedules.
- Weekdays: ${WEEKDAY_LIST}
- Targets: channel:<id> or user:<id>
- Schedule changes reload the running runtime immediately and still have a 30-second polling fallback.
- Shell sleeps and long-running waits are unsuitable for reminder requests.

Schedule examples
${SCHEDULE_ADD_EXAMPLES.map((example) => `- ${example}`).join("\n")}

Runtime
- Use aide restart after endpoint or token changes.
- Use aide status, aide logs, aide doctor, and aide usage to inspect the runtime.
`;
}
