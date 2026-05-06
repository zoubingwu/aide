import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAideHome, writeRuntimeState } from "../src/lib/config.js";
import { RUNTIME_LOG_FILE } from "../src/lib/logging.js";
import { logsDir } from "../src/lib/paths.js";
import { requestScheduleReload, SCHEDULE_RELOAD_SIGNAL } from "../src/lib/schedule-reload.js";

const cleanupPaths: string[] = [];

describe("schedule reload requests", () => {
  afterEach(() => {
    vi.restoreAllMocks();

    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("does nothing when the runtime is stopped", () => {
    const home = tempHome();
    ensureAideHome(home);

    expect(requestScheduleReload(home)).toBe(false);
  });

  it("signals a running runtime to reload schedules", () => {
    const home = tempHome();
    ensureAideHome(home);
    writeRuntimeState(home, {
      status: "running",
      home,
      pid: 12345
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(requestScheduleReload(home)).toBe(true);
    expect(kill).toHaveBeenCalledWith(12345, 0);
    expect(kill).toHaveBeenCalledWith(12345, SCHEDULE_RELOAD_SIGNAL);
    expect(fs.readFileSync(path.join(logsDir(home), RUNTIME_LOG_FILE), "utf8")).toContain("schedule_reload_requested");
  });
});

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-schedule-reload-"));
  cleanupPaths.push(target);
  return target;
}
