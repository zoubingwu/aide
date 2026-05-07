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
aide endpoint add discord
aide start
```

The setup asks for:

- An endpoint id, used to name this assistant surface and its local settings.
- A Discord bot token, stored in `~/.aide/.env.local`.

After `aide start`, mention the bot in a Discord channel where it has access.

## Runtime Config

Codex works out of the box:

```toml
[runtime]
provider = "codex"
command = "codex"
args = ["exec", "resume", "--last", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"]
model = "gpt-5.5"
reasoningEffort = "medium"
```

Edit `~/.aide/config.toml` to change the Codex command, model, or args.

## Useful Commands

```bash
aide status
aide logs
aide usage
aide doctor

aide config get
aide config set runtime.model gpt-5.5
aide config set runtime.reasoningEffort high

aide endpoint list
aide endpoint show <id>
aide endpoint test <id> --message "hello"
aide endpoint open <id>
aide endpoint config open <id>

aide schedule add "Check failed jobs" --id failed-jobs --kind cron --cron "*/15 * * * *" --endpoint <id> --target channel:<channel-id>
aide schedule add "Daily brief" --id daily-brief --kind daily --endpoint <id> --target channel:<channel-id> --time 09:00
aide schedule list
aide schedule pause --id daily-brief

aide stop
```
