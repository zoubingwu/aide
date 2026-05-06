# Aide

Turn an agentic CLI into your personal assistant.

Aide connects an agentic CLI to assistant endpoints. The MVP supports Discord endpoints, creates a private workspace per endpoint, and runs Codex by default inside the matching workspace when a message arrives.

## Install

```bash
bun install
bun run build
```

`bun run build` creates a bundled CLI at `dist/cli.js`. Use it directly during development:

```bash
node dist/cli.js --help
```

## Initialize

```bash
aide init
```

This creates:

```text
~/.aide/
  config.toml
  endpoints.toml
  runtime.json
  usage.jsonl
  logs/
    runtime.log
    activity.jsonl
  workspace/
```

Use `AIDE_HOME=/path/to/home` or `--home /path/to/home` for isolated local testing.

## Add A Discord Endpoint

Interactive:

```bash
aide endpoint add discord
```

The interactive flow first shows Discord setup links, then prompts for an endpoint id and a Discord bot token.

Scripted:

```bash
aide endpoint add discord \
  --id discord-agent-ops \
  --token "$DISCORD_BOT_TOKEN"
```

The endpoint id is used for the token key and workspace path. Aide stores endpoint tokens in `~/.aide/.env.local` using endpoint-specific keys such as `AIDE_DISCORD_TOKEN_DISCORD_AGENT_OPS`.

Discord setup happens in Discord:

1. Create or open an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Copy the bot token from the Bot page.
3. Install the app to a server with the `bot` scope from [Discord install settings](https://docs.discord.com/developers/quick-start/getting-started#adding-scopes-and-bot-permissions).
4. Grant the bot `View Channel` and `Send Messages` in channels where it should respond. See [Discord permissions](https://docs.discord.com/developers/topics/permissions).

After Aide saves the endpoint, run `aide start` and mention the bot in an allowed channel. See [Message Content Intent rules](https://docs.discord.com/developers/events/gateway#message-content-intent).

## Run

```bash
aide start
```

The runtime starts in the background, stores its PID in `runtime.json`, listens for Discord mentions, runs the configured agent CLI from the endpoint workspace, and posts the final response back to Discord.

Stop it from another terminal:

```bash
aide stop
```

## Agent CLI Invocation

The default agent provider is Codex:

```toml
[runtime]
provider = "codex"
command = "codex"
args = ["exec", "resume", "--last", "--json", "--skip-git-repo-check"]
model = "gpt-5.5"
reasoningEffort = "medium"
```

Aide dispatches execution through the configured provider adapter and runs the process with `cwd` set to the endpoint workspace. For Codex, `model` maps to `--model`, and `reasoningEffort` maps to `-c model_reasoning_effort=...`. The current provider is `codex`; the adapter boundary is ready for additional CLIs such as Claude Code or OpenCode.

## Commands

```bash
aide status
aide logs
aide logs --activity
aide tokens
aide doctor

aide endpoint list
aide endpoint show <id>
aide endpoint pause <id>
aide endpoint resume <id>
aide endpoint remove <id>
aide endpoint test <id> --message "hello"
aide endpoint open <id>
aide endpoint config list <id>
aide endpoint config open <id>
```

## Development

```bash
bun run typecheck
bun run test
bun run build
```
