import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restartCommand } from "../src/commands/runtime.js";
import { ensureAideHome } from "../src/lib/config.js";
import { deferredRestartPath } from "../src/lib/paths.js";
import {
  DEFER_RUNTIME_RESTART_ENV,
  DEFER_RUNTIME_RESTART_ID_ENV,
  DEFER_RUNTIME_RESTART_HOME_ENV
} from "../src/lib/runtime-restart.js";

const cleanupPaths: string[] = [];

describe("runtime restart", () => {
  afterEach(() => {
    vi.restoreAllMocks();

    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("queues restarts requested from an active agent run", async () => {
    const home = tempHome();
    ensureAideHome(home);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await withEnv(
      {
        [DEFER_RUNTIME_RESTART_ENV]: "1",
        [DEFER_RUNTIME_RESTART_HOME_ENV]: home,
        [DEFER_RUNTIME_RESTART_ID_ENV]: "discord:main:message-1"
      },
      () => restartCommand({ home })
    );

    expect(fs.existsSync(deferredRestartPath(home))).toBe(true);
    expect(JSON.parse(fs.readFileSync(deferredRestartPath(home), "utf8"))).toMatchObject({
      requests: [{ id: "discord:main:message-1" }]
    });
    expect(deferredRestartPath(home)).toBe(path.join(home, "state", "deferred-restart.json"));
    expect(log).toHaveBeenCalledWith("Aide runtime restart queued after the active agent response is delivered.");
  });
});

async function withEnv(values: Record<string, string>, task: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    await task();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
}

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-runtime-restart-"));
  cleanupPaths.push(target);
  return target;
}
