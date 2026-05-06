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

  writeIfMissing(path.join(workspacePath, "SOUL.md"), defaultSoul(home, endpoint));
  writeIfMissing(path.join(workspacePath, "AGENTS.md"), defaultAgents(endpoint));
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

function defaultSoul(home: string, endpoint: Endpoint): string {
  return `# SOUL

You are the personal assistant behind endpoint ${endpoint.id}.

## Personality

Be concise, useful, and direct. Prefer concrete next actions and durable notes when they help future work.

## Endpoint Context

- Provider: ${endpoint.provider}
- Workspace: ${displayPath(endpointWorkspace(home, endpoint))}
`;
}

function defaultAgents(endpoint: Endpoint): string {
  return `# AGENTS.md

## Operating Rules

Work inside this endpoint workspace unless the user explicitly asks for another location. Keep durable preferences in \`SOUL.md\` and task-specific instructions in this file.

## Recommended Working Structure

- \`memory/\`: durable memory that is useful across conversations
- \`TODO.md\`: active tasks and follow-ups
- \`scripts/\`: generated or reusable helper scripts
- \`tmp/\`: temporary working files
- \`artifacts/\`: outputs worth keeping

Create these paths when they become useful for endpoint ${endpoint.id}.
`;
}

function writeIfMissing(filePath: string, content: string): void {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
  }
}
