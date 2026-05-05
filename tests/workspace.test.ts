import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    const endpoint = makeEndpoint(home);

    ensureEndpointWorkspace(endpoint);

    const status = inspectEndpointWorkspace(endpoint);
    expect(status.exists).toBe(true);
    expect(status.soulExists).toBe(true);
    expect(status.agentsExists).toBe(true);
    expect(fs.readFileSync(path.join(endpoint.workspacePath, "AGENTS.md"), "utf8")).toContain("Recommended Working Structure");
  });
});

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-workspace-"));
  cleanupPaths.push(target);
  return target;
}

function makeEndpoint(home: string): Endpoint {
  return {
    id: "discord-agent-ops",
    provider: "discord",
    name: "Discord #agent-ops",
    enabled: true,
    workspacePath: endpointWorkspacePath(home, "discord-agent-ops"),
    routing: {
      mode: "mention_only",
      server: "agent-lab",
      channel: "#agent-ops"
    },
    permissions: {
      requireApprovalForShell: true,
      requireApprovalForWrites: true,
      restrictToEndpointWorkspace: true
    }
  };
}
