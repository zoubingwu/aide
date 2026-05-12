import type { ScheduleKind, Weekday } from "../lib/types.js";

export const SCHEDULE_KINDS = ["cron", "hourly", "daily", "weekly", "biweekly", "monthly", "once"] as const satisfies readonly ScheduleKind[];
export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const satisfies readonly Weekday[];

export const SCHEDULE_KIND_LIST = SCHEDULE_KINDS.join(" | ");
export const WEEKDAY_LIST = WEEKDAYS.join(" | ");

export const CONFIG_EXAMPLES = ["aide config list"];

export function agentHelpCommand(): void {
  console.log(agentHelpText());
}

function agentHelpText(): string {
  return `Aide Agent Guide

Edit Aide files directly when asked to inspect or change settings and schedules. Use runtime commands only for validation, logs, and process lifecycle.

When the prompt includes Source: channel:<id> or Source: user:<id>, use that source as the default schedule target. When the user names another target, use the user's target.

Files
- Default home: ~/.aide
- AIDE_HOME overrides the default home.
- Config: <home>/config.toml
- Schedules: <home>/schedules.json
- Runtime state: <home>/runtime.json
- Usage events: <home>/usage.jsonl
- Logs: <home>/logs/
- Endpoint workspace: <home>/workspace/<endpoint-id>/
- Endpoint instructions: <home>/workspace/<endpoint-id>/AGENTS.md

Config file
- File: <home>/config.toml
- Format: TOML.
- Token values belong in this file and should stay out of terminal output.
- Each endpoint is one [[endpoints]] table.
- Supported endpoint provider: discord.
- Supported agent provider: codex.
- Trigger source values use channel:<id>.
- Agent command, model, and reasoning effort apply on the next agent request.
- Endpoint token and trigger changes apply on the next start or restart.

Config example
  [[endpoints]]
  id = "discord"
  provider = "discord"
  enabled = true
  token = "<discord-bot-token>"
  trigger = { requireMention = true, freeResponseSources = ["channel:123"] }
  agent = { provider = "codex", command = "codex", model = "gpt-5.5", reasoningEffort = "medium" }

Trigger guide
- Trigger settings are per endpoint.
- Direct messages always trigger the endpoint.
- Server channels require a bot mention by default: endpoints.<id>.trigger.requireMention = true
- Set trigger.requireMention false to respond to every accessible server-channel message for that endpoint.
- Set trigger.freeResponseSources to a channel list for mention-free channels, such as ["channel:123", "channel:456"].
- A thread whose parent channel is listed in freeResponseSources also triggers without a mention.
- Mention-free server-channel triggers require Message Content Intent in the Discord Developer Portal.
- When a user asks to make the current Discord channel mention-free, add Source: channel:<id> to trigger.freeResponseSources, then run aide restart.

Schedule file
- File: <home>/schedules.json
- Format: JSON.
- Root shape: { "schedules": [] }
- Each schedule needs id, endpoint, enabled, kind, target, and message.
- Kinds: ${SCHEDULE_KIND_LIST}
- Use kind "cron" with cron for exact schedules.
- Use kind "once" with runAt for delayed reminders, relative-time reminders, and timed follow-ups.
- Cron uses 5 fields: minute hour day-of-month month day-of-week.
- High-level kinds are available for human-friendly daily, weekly, monthly, and one-shot schedules.
- Weekdays: ${WEEKDAY_LIST}
- Targets: channel:<id> or user:<id>
- Shell sleeps and long-running waits are unsuitable for reminder requests.
- Manual schedule file changes apply after aide restart.

Schedule field shapes
- cron: kind, cron, timezone
- hourly: kind, minute, timezone
- daily: kind, time, timezone
- weekly: kind, weekday, time, timezone
- biweekly: kind, weekday, startDate, time, timezone
- monthly: kind, day, time, timezone
- once: kind, runAt

Schedule example
  {
    "schedules": [
      {
        "id": "failed-jobs",
        "endpoint": "discord",
        "enabled": true,
        "kind": "cron",
        "target": "channel:123",
        "message": "Check failed jobs.",
        "cron": "*/15 * * * *",
        "timezone": "Asia/Shanghai"
      },
      {
        "id": "launch-reminder",
        "endpoint": "discord",
        "enabled": true,
        "kind": "once",
        "target": "channel:123",
        "message": "One-off reminder.",
        "runAt": "2026-05-08T09:00:00+08:00"
      }
    ]
  }

Runtime
- Run aide doctor after file edits.
- Run aide restart after endpoint token, trigger, or schedule file edits.
- Use aide status, aide logs, aide doctor, and aide usage to inspect the runtime.
`;
}
