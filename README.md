# Aide

Turn the coding agent you already use into an always-available assistant.

Aide gives long-lived coding agents a home outside the terminal. Point it at the Codex, Claude Code, opencode, or similar setup you have already tuned: skills, tools, auth, working directories, memory, and operating habits.

The core idea is simple: your coding agent is already a strong general-purpose agent. Aide lets you bring that agent into chat and scheduled work, so the same assistant can help with engineering tasks, research, operations, writing, planning, and daily briefs.

Aide's bet is that mature coding-agent CLIs already contain the hard parts of useful agents. The product layer should stay thin: route requests, run the CLI, deliver the result.

## Why

Use Aide when you want:

- A personal assistant powered by your existing coding agent configuration.
- Chat-based access to the agent that already knows your tools and preferences.
- Scheduled prompts for briefs, reminders, checks, and recurring workflows.
- A thin and stable runtime that keeps the agent close to the CLI you already trust.

Many agent platforms add orchestration layers, custom planners, tool wrappers, memory systems, and hosting assumptions. Aide keeps the operating model direct:

```text
assistant surface -> agent CLI -> response
```

## Install

```bash
npm install -g @inksphere/aide
```

Requirements:

- Node.js 20+
- A supported agent CLI installed and authenticated
- A bot token for Discord or other IM apps

Check the CLI:

```bash
aide --help
```

## Quick Start With Discord

```bash
aide init
```

The setup checks your local agent CLI, discovers existing Hermes or OpenClaw Discord tokens, imports usable endpoints, creates a Discord endpoint when needed, runs doctor, and can start the runtime.

When Aide needs a new endpoint, setup asks for:

- An endpoint provider. Discord is the currently runnable endpoint.
- An endpoint id, used to name this assistant surface and its local settings.
- A Discord bot token, stored in `~/.aide/config.toml`.
- A locally installed CLI agent. Codex is the currently runnable agent.

After `aide start`, mention the bot in a Discord channel where it has access.

To migrate existing Discord bot tokens from Hermes or OpenClaw:

```bash
aide import hermes
aide import openclaw
aide import all
```

OpenClaw `file` and `exec` SecretRefs require confirmation before Aide reads a file or runs a resolver command.

## Config

Endpoints bind a transport provider to a CLI agent:

```toml
[[endpoints]]
id = "discord"
provider = "discord"
enabled = true
token = "<discord-bot-token>"
trigger = { requireMention = true, freeResponseSources = [] }
agent = { provider = "codex", command = "codex", model = "gpt-5.5", reasoningEffort = "medium" }
```

Edit `~/.aide/config.toml` to change endpoint token, agent command, model, or reasoning effort.

## Useful Commands

```bash
aide status
aide logs
aide usage
aide doctor

aide config get
aide config set endpoints.discord.token <discord-bot-token>
aide config set endpoints.discord.agent.model gpt-5.5
aide config set endpoints.discord.agent.reasoningEffort high

aide endpoint list
aide endpoint show <id>
aide endpoint test <id> --message "hello"
aide endpoint open <id>
aide endpoint config open <id>

aide import hermes
aide import openclaw

aide schedule add "Check failed jobs" --id failed-jobs --kind cron --cron "*/15 * * * *" --endpoint <id> --target channel:<channel-id>
aide schedule add "Daily brief" --id daily-brief --kind daily --endpoint <id> --target channel:<channel-id> --time 09:00
aide schedule list
aide schedule pause --id daily-brief

aide stop
```
