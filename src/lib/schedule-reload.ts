import { appendRuntimeLog } from "./logging.js";
import { runtimeDisplayStatus } from "./runtime-state.js";

export const SCHEDULE_RELOAD_SIGNAL = "SIGHUP";

export function requestScheduleReload(home: string): boolean {
  const runtime = runtimeDisplayStatus(home);

  if (runtime.status !== "running" || !runtime.pid) {
    return false;
  }

  try {
    process.kill(runtime.pid, SCHEDULE_RELOAD_SIGNAL);
    appendRuntimeLog(home, "schedule_reload_requested", { pid: runtime.pid });
    return true;
  } catch (error) {
    appendRuntimeLog(home, "schedule_reload_request_failed", {
      pid: runtime.pid,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}
