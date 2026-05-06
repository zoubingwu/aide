import { Cron } from "croner";
import type { Client } from "discord.js";
import { handleAssistantRequest } from "./assistant.js";
import { deliverDiscordMessage } from "./discord-delivery.js";
import { appendRuntimeLog } from "./logging.js";
import { buildSchedulePlan, isBiweeklyOccurrence } from "./schedule-plan.js";
import { loadSchedules, removeSchedule } from "./schedules.js";
import type { AgentRunResult, Endpoint, Schedule } from "./types.js";

const ONCE_RETRY_MS = 60_000;
const RELOAD_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_000_000;

export interface ScheduleExecution {
  home: string;
  schedule: Schedule;
  endpoints: Endpoint[];
  clients: ReadonlyMap<string, unknown>;
  handleRequest?: (home: string, endpoint: Endpoint, message: string, author: string) => Promise<AgentRunResult>;
  deliver?: (endpoint: Endpoint, client: unknown, target: string, response: string) => Promise<void>;
}

export interface RuntimeSchedulerOptions {
  home: string;
  endpoints: Endpoint[];
  clients: ReadonlyMap<string, Client>;
}

interface RunningJob {
  stop(): void;
}

export async function executeScheduleOnce(execution: ScheduleExecution): Promise<void> {
  const endpoint = execution.endpoints.find((candidate) => candidate.id === execution.schedule.endpoint);

  if (!endpoint || !endpoint.enabled) {
    appendRuntimeLog(execution.home, "schedule_invalid", {
      schedule: execution.schedule.id,
      endpoint: execution.schedule.endpoint
    });
    return;
  }

  const client = execution.clients.get(endpoint.id);

  if (!client) {
    appendRuntimeLog(execution.home, "schedule_invalid", {
      schedule: execution.schedule.id,
      endpoint: endpoint.id,
      reason: "missing client"
    });
    return;
  }

  appendRuntimeLog(execution.home, "schedule_started", {
    schedule: execution.schedule.id,
    endpoint: endpoint.id
  });

  const request = execution.handleRequest ?? handleAssistantRequest;
  const result = await request(execution.home, endpoint, execution.schedule.message, `schedule:${execution.schedule.id}`);

  if (result.exitCode !== 0) {
    appendRuntimeLog(execution.home, "schedule_agent_failed", {
      schedule: execution.schedule.id,
      endpoint: endpoint.id,
      exitCode: result.exitCode
    });
    return;
  }

  const deliver = execution.deliver ?? deliverScheduleResponse;

  try {
    await deliver(endpoint, client, execution.schedule.target, result.response);
  } catch (error) {
    appendRuntimeLog(execution.home, deliveryErrorEvent(error), {
      schedule: execution.schedule.id,
      endpoint: endpoint.id,
      error: errorMessage(error)
    });
    return;
  }

  appendRuntimeLog(execution.home, "schedule_delivered", {
    schedule: execution.schedule.id,
    endpoint: endpoint.id
  });

  if (execution.schedule.kind === "once") {
    removeSchedule(execution.home, execution.schedule.id);
    appendRuntimeLog(execution.home, "schedule_once_removed", {
      schedule: execution.schedule.id
    });
  }
}

export class RuntimeScheduler {
  private readonly jobs = new Map<string, RunningJob>();
  private readonly running = new Set<string>();
  private reloadTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: RuntimeSchedulerOptions) {}

  start(): void {
    this.reload();
    this.reloadTimer = setInterval(() => this.reload(), RELOAD_MS);
    appendRuntimeLog(this.options.home, "schedule_loaded", { count: this.jobs.size });
  }

  stop(): void {
    for (const job of this.jobs.values()) {
      job.stop();
    }
    this.jobs.clear();

    if (this.reloadTimer) {
      clearInterval(this.reloadTimer);
      this.reloadTimer = undefined;
    }
  }

  reload(): void {
    for (const job of this.jobs.values()) {
      job.stop();
    }
    this.jobs.clear();

    for (const schedule of loadSchedules(this.options.home).filter((candidate) => candidate.enabled)) {
      this.jobs.set(schedule.id, this.createJob(schedule));
    }
  }

  private createJob(schedule: Schedule): RunningJob {
    const plan = buildSchedulePlan(schedule);

    if (plan.kind === "once") {
      return this.createOnceJob(schedule, plan.runAt);
    }

    const cron = new Cron(
      plan.expression,
      {
        mode: "5-part",
        timezone: plan.timezone
      },
      () => {
        void this.run(schedule);
      }
    );

    return { stop: () => cron.stop() };
  }

  private createOnceJob(schedule: Schedule, runAt: string): RunningJob {
    let timer: NodeJS.Timeout | undefined;

    const scheduleNext = () => {
      const delay = Math.max(0, new Date(runAt).getTime() - Date.now());

      if (delay > MAX_TIMEOUT_MS) {
        timer = setTimeout(scheduleNext, MAX_TIMEOUT_MS);
        return;
      }

      timer = setTimeout(async () => {
        await this.run(schedule);

        if (loadSchedules(this.options.home).some((candidate) => candidate.id === schedule.id)) {
          timer = setTimeout(scheduleNext, ONCE_RETRY_MS);
        }
      }, Math.min(delay, MAX_TIMEOUT_MS));
    };

    scheduleNext();

    return {
      stop: () => {
        if (timer) {
          clearTimeout(timer);
        }
      }
    };
  }

  private async run(schedule: Schedule): Promise<void> {
    if (this.running.has(schedule.id)) {
      appendRuntimeLog(this.options.home, "schedule_skipped_running", { schedule: schedule.id });
      return;
    }

    if (
      schedule.kind === "biweekly" &&
      schedule.startDate &&
      !isBiweeklyOccurrence(schedule.startDate, new Date(), schedule.timezone)
    ) {
      return;
    }

    this.running.add(schedule.id);
    appendRuntimeLog(this.options.home, "schedule_due", { schedule: schedule.id });

    try {
      await executeScheduleOnce({
        home: this.options.home,
        schedule,
        endpoints: this.options.endpoints,
        clients: this.options.clients
      });
    } finally {
      this.running.delete(schedule.id);
    }
  }
}

async function deliverScheduleResponse(endpoint: Endpoint, client: unknown, target: string, response: string): Promise<void> {
  if (endpoint.provider === "discord") {
    await deliverDiscordMessage(client as Client, target, response);
    return;
  }

  throw new Error(`Unsupported delivery provider: ${endpoint.provider}`);
}

function deliveryErrorEvent(error: unknown): "schedule_delivery_failed" | "schedule_delivery_invalid" {
  return errorMessage(error).startsWith("Unsupported Discord target:")
    ? "schedule_delivery_invalid"
    : "schedule_delivery_failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
