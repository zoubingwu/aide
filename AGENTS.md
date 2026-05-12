# AGENTS.md

## Project Shape

Aide is a TypeScript CLI package. Runtime code targets Node-compatible APIs and is developed with Bun.

## Source Map

- `src/cli.ts`: CLI entrypoint and command registration.
- `src/commands/system.ts`: `init`, `status`, `logs`, `usage`, `doctor`.
- `src/commands/config.ts`: root runtime config `get` and `set` commands.
- `src/commands/endpoints.ts`: endpoint CRUD, config commands, local endpoint tests.
- `src/commands/help.ts`: reusable CLI help constants, examples, and agent-facing guide.
- `src/commands/import.ts`: import command for migrating Discord endpoints from Hermes and OpenClaw.
- `src/commands/onboarding.ts`: idempotent `init` onboarding orchestration.
- `src/commands/runtime.ts`: `start`, `stop`, `restart`, and foreground runtime dispatch.
- `src/commands/schedules.ts`: schedule CRUD and schedule config commands.
- `src/commands/service.ts`: OS service install, uninstall, and status commands.
- `src/lib/config.ts`: TOML config, JSON runtime state, JSON schedules data, and schema validation.
- `src/lib/paths.ts`: Aide home, display paths, endpoint id helpers.
- `src/lib/workspace.ts`: endpoint workspace creation and validation.
- `src/lib/agents.ts`: supported CLI agent catalog, default agent config dispatch, and local install detection.
- `src/lib/agent-tools.ts`: provider-neutral tool server references for agent executions.
- `src/lib/agent-progress.ts`: compact agent event formatting for verbose Discord progress output.
- `src/lib/agent.ts`: agent provider dispatch and shared prompt construction.
- `src/lib/discord-commands.ts`: Discord slash command registration, interaction controls, and active-run tracking.
- `src/lib/discord-context.ts`: scoped Discord request context, history fetching, and message normalization.
- `src/lib/discord-context-mcp.ts`: request-scoped MCP server exposing Discord context tools.
- `src/lib/discord-message-chunks.ts`: Discord message splitting and Markdown fence preservation.
- `src/lib/discord-messages.ts`: Discord message trigger handling, typing, progress output, context tool startup, and response delivery.
- `src/lib/codex-args.ts`: shared Codex default resume and fresh execution args.
- `src/lib/codex.ts`: Codex provider args, execution, JSONL response extraction.
- `src/lib/assistant.ts`: shared assistant request flow.
- `src/lib/discord.ts`: Discord listener and message delivery.
- `src/lib/discord-delivery.ts`: Discord target parsing and scheduled message delivery.
- `src/lib/delivery-retries.ts`: persistent scheduled delivery retry queue and backoff state.
- `src/lib/doctor.ts`: shared doctor checks and base path repair.
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
- `src/lib/openclaw-config.ts`: OpenClaw home/config path resolution, JSON5 loading, `$include` expansion, shell env planning, and config env fallback extraction.
- `src/lib/import-sources.ts`: stable public facade for import source discovery and endpoint import planning.
- `src/lib/import-sources/`: Hermes discovery, OpenClaw discovery, OpenClaw SecretRef resolution, access policy mapping, import planning, and import-source helpers.
- `tests/`: unit tests for non-network behavior.

## Development Rules

Keep endpoint as the public concept and workspace as implementation detail. Prefer small command handlers and focused helpers over broad service classes. Use TOML helpers for config changes. Endpoint tokens live in `config.toml`; keep token values out of terminal output and commits.

Run these checks before handoff:

```bash
bun run typecheck
bun run test
bun run build
```

Use `bun run test` for test runs so the repository's Vitest script and configuration are always used.
