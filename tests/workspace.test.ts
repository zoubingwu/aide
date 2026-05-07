import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultCodexAgentConfig } from "../src/lib/config.js";
import { endpointWorkspacePath } from "../src/lib/paths.js";
import { ensureEndpointWorkspace, inspectEndpointWorkspace } from "../src/lib/workspace.js";
import type { Endpoint } from "../src/lib/types.js";

const cleanupPaths: string[] = [];

describe("workspace", () => {
  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("creates SOUL.md and AGENTS.md for an endpoint", () => {
    const home = tempHome();
    const endpoint = makeEndpoint();
    const workspacePath = endpointWorkspacePath(home, endpoint.id);

    ensureEndpointWorkspace(home, endpoint);

    const status = inspectEndpointWorkspace(home, endpoint);
    expect(status.exists).toBe(true);
    expect(status.soulExists).toBe(true);
    expect(status.agentsExists).toBe(true);

    const soul = fs.readFileSync(path.join(workspacePath, "SOUL.md"), "utf8");
    const agents = fs.readFileSync(path.join(workspacePath, "AGENTS.md"), "utf8");

    expect(soul).toContain("## Identity");
    expect(soul).toContain("## Communication");
    expect(soul).toContain("## Technical Posture");
    expect(soul).not.toContain("Endpoint Context");
    expect(agents).toContain("## Workspace Rules");
    expect(agents).toContain("## Aide Runtime Management");
    expect(agents).toContain("aide help agent");
    expect(agents).toContain("Use Aide schedules for delayed reminders");
    expect(agents).toContain("--kind once");
    expect(agents).toContain("--run-at");
    expect(agents).toContain("## Working Structure");
  });
});

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-workspace-"));
  cleanupPaths.push(target);
  return target;
}

function makeEndpoint(): Endpoint {
  return {
    id: "discord-agent-ops",
    provider: "discord",
    enabled: true,
    token: "test-token",
    agent: defaultCodexAgentConfig()
  };
}
