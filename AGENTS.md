# AGENTS.md

## Project Shape

Aide is a TypeScript CLI package. Runtime code targets Node-compatible APIs and is developed with Bun.

## Source Map

- `src/cli.ts`: CLI entrypoint and command registration.
- `src/commands/system.ts`: `init`, `status`, `logs`, `usage`, `doctor`.
- `src/commands/config.ts`: root runtime config `get` and `set` commands.
- `src/commands/endpoints.ts`: endpoint CRUD, config commands, local endpoint tests.
- `src/commands/help.ts`: reusable CLI help constants, examples, and agent-facing guide.
- `src/commands/runtime.ts`: `start`, `stop`, `restart`, and foreground runtime dispatch.
- `src/commands/schedules.ts`: schedule CRUD and schedule config commands.
- `src/commands/service.ts`: OS service install, uninstall, and status commands.
- `src/lib/config.ts`: TOML config, JSON runtime state, JSON schedules data, and schema validation.
- `src/lib/paths.ts`: Aide home, display paths, endpoint id helpers.
- `src/lib/workspace.ts`: endpoint workspace creation and validation.
- `src/lib/agent.ts`: agent provider dispatch and shared prompt construction.
- `src/lib/codex-args.ts`: shared Codex default resume and fresh execution args.
- `src/lib/codex.ts`: Codex provider args, execution, JSONL response extraction.
- `src/lib/assistant.ts`: shared assistant request flow.
- `src/lib/discord.ts`: Discord listener and message delivery.
- `src/lib/discord-delivery.ts`: Discord target parsing and scheduled message delivery.
- `src/lib/schedules.ts`: JSON schedule data validation and mutations.
- `src/lib/schedule-plan.ts`: user schedule kind normalization into cron or one-shot plans.
- `src/lib/schedule-reload.ts`: signal running runtime to reload schedule jobs after schedule config mutations.
- `src/lib/scheduler.ts`: runtime schedule jobs, overlap handling, and one-shot cleanup.
- `src/lib/service.ts`: launchd and systemd user service file generation and lifecycle.
- `src/lib/runtime.ts`: background process launch and runtime lifecycle.
- `src/lib/runtime-state.ts`: PID state helpers.
- `src/lib/usage.ts`: JSONL usage events and estimated token accounting.
- `src/lib/logging.ts`: runtime log and activity JSONL events.
- `src/lib/format.ts`: CLI output helpers.
- `tests/`: unit tests for non-network behavior.

## Development Rules

Keep endpoint as the public concept and workspace as implementation detail. Prefer small command handlers and focused helpers over broad service classes. Use TOML helpers for config changes. Endpoint tokens live in `config.toml`; keep token values out of terminal output and commits.

Run these checks before handoff:

```bash
bun run typecheck
bun run test
bun run build
```
