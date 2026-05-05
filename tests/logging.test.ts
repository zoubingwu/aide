import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTIVITY_LOG_FILE, appendActivityLog } from "../src/lib/logging.js";
import { logsDir } from "../src/lib/paths.js";

const cleanupPaths: string[] = [];

describe("logging", () => {
  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("writes activity events as JSON Lines", () => {
    const home = tempHome();

    appendActivityLog(home, {
      endpoint: "discord-agent-ops",
      endpointWorkspace: "/tmp/discord-agent-ops",
      provider: "discord",
      event: "message_received",
      tokens: 12
    });

    const filePath = path.join(logsDir(home), ACTIVITY_LOG_FILE);
    const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/);
    expect(path.basename(filePath)).toBe("activity.jsonl");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      endpoint: "discord-agent-ops",
      event: "message_received",
      tokens: 12
    });
  });
});

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-logging-"));
  cleanupPaths.push(target);
  return target;
}
