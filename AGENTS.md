# AGENTS.md

## Project Shape

Aide is a TypeScript CLI package. Runtime code targets Node-compatible APIs and is developed with Bun.

## Source Map

- `src/cli.ts`: CLI entrypoint and command registration.
- `src/commands/system.ts`: `init`, `status`, `logs`, `tokens`, `doctor`.
- `src/commands/endpoints.ts`: endpoint CRUD, config commands, local endpoint tests.
- `src/commands/runtime.ts`: `start`, `stop`, `restart`.
- `src/lib/config.ts`: TOML user config, JSON runtime state, and schema validation.
- `src/lib/paths.ts`: Aide home, display paths, endpoint id helpers.
- `src/lib/workspace.ts`: endpoint workspace creation and validation.
- `src/lib/secrets.ts`: Discord token fallback in env and `.env.local`.
- `src/lib/codex.ts`: Codex process args, execution, JSONL response extraction.
- `src/lib/assistant.ts`: shared assistant request flow.
- `src/lib/discord.ts`: Discord listener and message delivery.
- `src/lib/runtime.ts`: foreground runtime lifecycle.
- `src/lib/runtime-state.ts`: PID state helpers.
- `src/lib/usage.ts`: JSONL usage events and estimated token accounting.
- `src/lib/logging.ts`: runtime log and activity JSONL events.
- `src/lib/format.ts`: CLI output helpers.
- `tests/`: unit tests for non-network behavior.

## Development Rules

Keep endpoint as the public concept and workspace as implementation detail. Prefer small command handlers and focused helpers over broad service classes. Use TOML helpers for config changes and keep secrets out of `endpoints.toml`.

Run these checks before handoff:

```bash
bun run typecheck
bun run test
bun run build
```
