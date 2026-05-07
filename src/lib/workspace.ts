import fs from "node:fs";
import path from "node:path";
import { displayPath, endpointWorkspacePath } from "./paths.js";
import type { Endpoint } from "./types.js";

export interface WorkspaceStatus {
  path: string;
  exists: boolean;
  soulExists: boolean;
  agentsExists: boolean;
}

export function endpointWorkspace(home: string, endpoint: Endpoint): string {
  return endpointWorkspacePath(home, endpoint.id);
}

export function ensureEndpointWorkspace(home: string, endpoint: Endpoint): void {
  const workspacePath = endpointWorkspace(home, endpoint);
  fs.mkdirSync(workspacePath, { recursive: true });

  writeIfMissing(path.join(workspacePath, "SOUL.md"), defaultSoul());
  writeIfMissing(path.join(workspacePath, "AGENTS.md"), defaultAgents());
}

export function inspectEndpointWorkspace(home: string, endpoint: Endpoint): WorkspaceStatus {
  const workspacePath = endpointWorkspace(home, endpoint);

  return {
    path: workspacePath,
    exists: fs.existsSync(workspacePath),
    soulExists: fs.existsSync(path.join(workspacePath, "SOUL.md")),
    agentsExists: fs.existsSync(path.join(workspacePath, "AGENTS.md"))
  };
}

export function assertEndpointWorkspace(home: string, endpoint: Endpoint): void {
  const status = inspectEndpointWorkspace(home, endpoint);

  if (!status.exists) {
    throw new Error(`Endpoint workspace is missing: ${displayPath(status.path)}`);
  }

  if (!status.soulExists || !status.agentsExists) {
    throw new Error(`Endpoint workspace config is incomplete: ${displayPath(status.path)}`);
  }
}

function defaultSoul(): string {
  return `# SOUL

You are Aide, a pragmatic personal assistant for the person who owns this assistant.

## Identity

- Act like a senior operator and engineer: direct, calm, and execution-focused.
- Optimize for clarity, useful decisions, and concrete next actions.
- Capture durable preferences when they will improve future conversations.

## Communication

- Keep responses concise unless the task needs depth.
- Ask a focused question when missing context blocks progress.
- State uncertainty plainly and explain the path to resolve it.
- Push back on brittle plans with specific alternatives.

## Technical Posture

- Prefer simple, maintainable solutions.
- Make changes easy to read, debug, and revise.
- Treat operational details, tests, and failure modes as part of the work.
`;
}

function defaultAgents(): string {
  return `# AGENTS.md

## Workspace Rules

This file holds endpoint-specific instructions, project notes, commands, paths, and workflows. Keep stable personality and communication preferences in \`SOUL.md\`.

Run work from this endpoint workspace by default. Endpoint tokens live in Aide's config.toml.

## Aide Runtime Management

When asked to inspect or change Aide settings or schedules, run \`aide help agent\` first to learn how to change settings or create schedules, then use the \`aide\` CLI. Prefer CLI commands over direct config edits.

Use Aide schedules for delayed reminders, relative-time reminders, recurring work, and timed follow-ups. For short delays such as "in 3 minutes", create a one-shot schedule with \`--kind once\` and \`--run-at\`. Shell sleeps and long-running waits are unsuitable for reminder requests.

## Working Structure

- \`memory/\`: durable user and project facts useful across conversations
- \`TODO.md\`: active tasks and follow-ups
- \`scripts/\`: reusable helper scripts
- \`tmp/\`: temporary working files
- \`artifacts/\`: outputs worth keeping

Create these paths when they become useful.
`;
}

function writeIfMissing(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
  }
}
