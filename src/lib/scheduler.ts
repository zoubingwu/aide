import { Cron } from "croner";
import type { Client } from "discord.js";
import { handleAssistantRequest } from "./assistant.js";
import {
  addPendingDelivery,
  duePendingDeliveries,
  loadPendingDeliveries,
  markPendingDeliveryFailed,
  removePendingDelivery,
  type PendingDelivery
} from "./delivery-retries.js";
import { deliverDiscordMessage } from "./discord-delivery.js";
import { appendRuntimeLog } from "./logging.js";
import { buildSchedulePlan, isBiweeklyOccurrence } from "./schedule-plan.js";
import { loadRuntimeSchedules, removeRuntimeSchedule } from "./schedules.js";
import type { AgentRunResult, Endpoint, Schedule } from "./types.js";

const ONCE_RETRY_MS = 60_000;
const RECURRING_RETRY_MS = 5 * 60_000;
const RECURRING_MAX_RETRIES = 3;
const RELOAD_MS = 30_000;
const DELIVERY_RETRY_POLL_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_000_000;

export interface ScheduleExecution {
  home: string;
  schedule: Schedule;
  endpoints: Endpoint[];
  clients: ReadonlyMap<string, unknown>;
  handleRequest?: ((home: string, endpoint: Endpoint, message: string, author: string) => Promise<AgentRunResult>) | undefined;
  deliver?: ((endpoint: Endpoint, client: unknown, target: string, response: string) => Promise<void>) | undefined;
}

export interface RuntimeSchedulerOptions {
  home: string;
  endpoints: Endpoint[];
  clients: ReadonlyMap<string, Client>;
  handleRequest?: ((home: string, endpoint: Endpoint, message: string, author: string) => Promise<AgentRunResult>) | undefined;
  deliver?: ((endpoint: Endpoint, client: unknown, target: string, response: string) => Promise<void>) | undefined;
}

interface RunningJob {
  stop(): void;
}

type ScheduleRunStatus = "ran" | "skipped";
type ScheduleExecutionStatus = "completed" | "agent_failed" | "delivery_invalid" | "delivery_pending" | "skipped";
type RunSource = "scheduled" | "retry";

export async function executeScheduleOnce(execution: ScheduleExecution): Promise<ScheduleExecutionStatus> {
  const endpoint = execution.endpoints.find((candidate) => candidate.id === execution.schedule.endpoint);

  if (!endpoint || !endpoint.enabled) {
    appendRuntimeLog(execution.home, "schedule_invalid", {
      schedule: execution.schedule.id,
      endpoint: execution.schedule.endpoint
    });
    return "skipped";
  }

  const client = execution.clients.get(endpoint.id);

  if (!client) {
    appendRuntimeLog(execution.home, "schedule_invalid", {
      schedule: execution.schedule.id,
      endpoint: endpoint.id,
      reason: "missing client"
    });
    return "skipped";
  }

  appendRuntimeLog(execution.home, "schedule_started", {
    schedule: execution.schedule.id,
    endpoint: endpoint.id
  });

  const request = execution.handleRequest ?? handleAssistantRequest;
  let result: AgentRunResult;

  try {
    result = await request(execution.home, endpoint, execution.schedule.message, `schedule:${execution.schedule.id}`);
  } catch (error) {
    appendRuntimeLog(execution.home, "schedule_agent_failed", {
      schedule: execution.schedule.id,
      endpoint: endpoint.id,
      error: errorMessage(error)
    });
    return "agent_failed";
  }

  if (result.exitCode !== 0) {
    appendRuntimeLog(execution.home, "schedule_agent_failed", {
      schedule: execution.schedule.id,
      endpoint: endpoint.id,
      exitCode: result.exitCode,
      error: result.response || result.stderr || undefined
    });
    return "agent_failed";
  }

  if (!result.hasTextResponse) {
    appendRuntimeLog(execution.home, "schedule_response_empty", {
      schedule: execution.schedule.id,
      endpoint: endpoint.id
    });
    completeSchedule(execution);
    return "completed";
  }

  const deliver = execution.deliver ?? deliverScheduleResponse;

  try {
    await deliver(endpoint, client, execution.schedule.target, result.response);
  } catch (error) {
    const message = errorMessage(error);
    const event = deliveryErrorEvent(error);
    appendRuntimeLog(execution.home, event, {
      schedule: execution.schedule.id,
      endpoint: endpoint.id,
      error: message
    });

    if (event === "schedule_delivery_invalid") {
      completeSchedule(execution);
      return "delivery_invalid";
    }

    try {
      const delivery = addPendingDelivery(execution.home, {
        scheduleId: execution.schedule.id,
        endpoint: endpoint.id,
        target: execution.schedule.target,
        response: result.response
      }, message);
      appendRuntimeLog(execution.home, "schedule_delivery_queued", {
        schedule: execution.schedule.id,
        endpoint: endpoint.id,
        delivery: delivery.id,
        nextRetryAt: delivery.nextRetryAt
      });
      completeSchedule(execution);
      return "delivery_pending";
    } catch (queueError) {
      appendRuntimeLog(execution.home, "schedule_delivery_queue_failed", {
        schedule: execution.schedule.id,
        endpoint: endpoint.id,
        error: errorMessage(queueError)
      });
      return "agent_failed";
    }
  }

  appendRuntimeLog(execution.home, "schedule_delivered", {
    schedule: execution.schedule.id,
    endpoint: endpoint.id
  });

  completeSchedule(execution);
  return "completed";
}

function completeSchedule(execution: ScheduleExecution): void {
  if (execution.schedule.kind !== "once") {
    return;
  }

  removeRuntimeSchedule(execution.home, execution.schedule.id);
  appendRuntimeLog(execution.home, "schedule_once_removed", {
    schedule: execution.schedule.id
  });
}

export class RuntimeScheduler {
  private readonly jobs = new Map<string, RunningJob>();
  private readonly running = new Set<string>();
  private readonly onceRetryAt = new Map<string, number>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly runningDeliveries = new Set<string>();
  private reloadTimer: NodeJS.Timeout | undefined;
  private deliveryRetryTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: RuntimeSchedulerOptions) {}

  start(): void {
    this.reload();
    this.reloadTimer = setInterval(() => this.reload(), RELOAD_MS);
    this.deliveryRetryTimer = setInterval(() => {
      void this.retryPendingDeliveries();
    }, DELIVERY_RETRY_POLL_MS);
    void this.retryPendingDeliveries({ force: true });
    appendRuntimeLog(this.options.home, "schedule_loaded", { count: this.jobs.size });
  }

  stop(): void {
    for (const job of this.jobs.values()) {
      job.stop();
    }
    this.jobs.clear();
    this.clearAllRecurringRetries();

    if (this.reloadTimer) {
      clearInterval(this.reloadTimer);
      this.reloadTimer = undefined;
    }

    if (this.deliveryRetryTimer) {
      clearInterval(this.deliveryRetryTimer);
      this.deliveryRetryTimer = undefined;
    }
  }

  reload(): void {
    for (const job of this.jobs.values()) {
      job.stop();
    }
    this.jobs.clear();

    let loaded: ReturnType<typeof loadRuntimeSchedules>;

    try {
      loaded = loadRuntimeSchedules(this.options.home);
    } catch (error) {
      appendRuntimeLog(this.options.home, "schedule_load_failed", { error: errorMessage(error) });
      return;
    }

    for (const issue of loaded.issues) {
      appendRuntimeLog(this.options.home, "schedule_invalid", {
        schedule: issue.id,
        index: issue.index,
        error: issue.error
      });
    }

    for (const schedule of loaded.schedules.filter((candidate) => candidate.enabled)) {
      try {
        this.jobs.set(schedule.id, this.createJob(schedule));
      } catch (error) {
        appendRuntimeLog(this.options.home, "schedule_invalid", {
          schedule: schedule.id,
          error: errorMessage(error)
        });
      }
    }

    this.pruneRecurringRetries(new Set(loaded.schedules.filter((candidate) => candidate.enabled).map((schedule) => schedule.id)));
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
        void this.run(schedule, "scheduled");
      }
    );

    return { stop: () => cron.stop() };
  }

  private createOnceJob(schedule: Schedule, runAt: string): RunningJob {
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;

    const scheduleNext = () => {
      if (stopped) {
        return;
      }

      const targetAt = Math.max(new Date(runAt).getTime(), this.onceRetryAt.get(schedule.id) ?? 0);
      const delay = Math.max(0, targetAt - Date.now());

      if (delay > MAX_TIMEOUT_MS) {
        timer = setTimeout(scheduleNext, MAX_TIMEOUT_MS);
        return;
      }

      timer = setTimeout(async () => {
        if (stopped) {
          return;
        }

        const status = await this.run(schedule);

        if (stopped || status === "skipped") {
          return;
        }

        if (this.scheduleExists(schedule.id)) {
          this.onceRetryAt.set(schedule.id, Date.now() + ONCE_RETRY_MS);
          timer = setTimeout(scheduleNext, ONCE_RETRY_MS);
        } else {
          this.onceRetryAt.delete(schedule.id);
        }
      }, Math.min(delay, MAX_TIMEOUT_MS));
    };

    scheduleNext();

    return {
      stop: () => {
        stopped = true;

        if (timer) {
          clearTimeout(timer);
        }
      }
    };
  }

  private async run(schedule: Schedule, source: RunSource = "scheduled"): Promise<ScheduleRunStatus> {
    if (this.running.has(schedule.id)) {
      appendRuntimeLog(this.options.home, "schedule_skipped_running", { schedule: schedule.id });
      return "skipped";
    }

    if (source === "scheduled" && schedule.kind !== "once") {
      this.clearRecurringRetry(schedule.id);
    }

    if (
      schedule.kind === "biweekly" &&
      schedule.startDate &&
      !isBiweeklyOccurrence(schedule.startDate, new Date(), schedule.timezone)
    ) {
      return "skipped";
    }

    this.running.add(schedule.id);
    appendRuntimeLog(this.options.home, "schedule_due", { schedule: schedule.id });

    let status: ScheduleExecutionStatus = "agent_failed";

    try {
      status = await executeScheduleOnce({
        home: this.options.home,
        schedule,
        endpoints: this.options.endpoints,
        clients: this.options.clients,
        handleRequest: this.options.handleRequest,
        deliver: this.options.deliver
      });
    } catch (error) {
      appendRuntimeLog(this.options.home, "schedule_run_failed", {
        schedule: schedule.id,
        error: errorMessage(error)
      });
      status = "agent_failed";
    } finally {
      this.running.delete(schedule.id);
    }

    if (schedule.kind !== "once") {
      this.updateRecurringRetry(schedule, status);
    }

    return "ran";
  }

  private updateRecurringRetry(schedule: Schedule, status: ScheduleExecutionStatus): void {
    if (status === "completed") {
      this.clearRecurringRetry(schedule.id);
      return;
    }

    if (status !== "agent_failed") {
      return;
    }

    const nextAttempt = (this.retryAttempts.get(schedule.id) ?? 0) + 1;

    if (nextAttempt > RECURRING_MAX_RETRIES) {
      this.clearRecurringRetry(schedule.id);
      appendRuntimeLog(this.options.home, "schedule_retry_exhausted", {
        schedule: schedule.id,
        attempts: RECURRING_MAX_RETRIES
      });
      return;
    }

    this.retryAttempts.set(schedule.id, nextAttempt);

    const existing = this.retryTimers.get(schedule.id);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.retryTimers.delete(schedule.id);
      const current = this.findEnabledSchedule(schedule.id);

      if (!current) {
        this.retryAttempts.delete(schedule.id);
        return;
      }

      void this.run(current, "retry");
    }, RECURRING_RETRY_MS);

    this.retryTimers.set(schedule.id, timer);
    appendRuntimeLog(this.options.home, "schedule_retry_scheduled", {
      schedule: schedule.id,
      attempt: nextAttempt,
      delayMs: RECURRING_RETRY_MS
    });
  }

  private clearRecurringRetry(id: string): void {
    const timer = this.retryTimers.get(id);

    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(id);
    }

    this.retryAttempts.delete(id);
  }

  private clearAllRecurringRetries(): void {
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }

    this.retryTimers.clear();
    this.retryAttempts.clear();
  }

  private pruneRecurringRetries(enabledIds: Set<string>): void {
    for (const id of this.retryTimers.keys()) {
      if (!enabledIds.has(id)) {
        this.clearRecurringRetry(id);
      }
    }
  }

  private findEnabledSchedule(id: string): Schedule | undefined {
    try {
      return loadRuntimeSchedules(this.options.home).schedules.find((schedule) => schedule.id === id && schedule.enabled);
    } catch (error) {
      appendRuntimeLog(this.options.home, "schedule_load_failed", { error: errorMessage(error) });
      return undefined;
    }
  }

  private scheduleExists(id: string): boolean {
    try {
      return loadRuntimeSchedules(this.options.home).schedules.some((schedule) => schedule.id === id);
    } catch (error) {
      appendRuntimeLog(this.options.home, "schedule_load_failed", { error: errorMessage(error) });
      return false;
    }
  }

  async retryPendingDeliveries(options: { force?: boolean } = {}): Promise<void> {
    let deliveries: PendingDelivery[];

    try {
      deliveries = options.force ? loadPendingDeliveries(this.options.home) : duePendingDeliveries(this.options.home);
    } catch (error) {
      appendRuntimeLog(this.options.home, "schedule_delivery_queue_load_failed", { error: errorMessage(error) });
      return;
    }

    for (const delivery of deliveries) {
      await this.retryPendingDelivery(delivery);
    }
  }

  private async retryPendingDelivery(delivery: PendingDelivery): Promise<void> {
    if (this.runningDeliveries.has(delivery.id)) {
      return;
    }

    const endpoint = this.options.endpoints.find((candidate) => candidate.id === delivery.endpoint);
    const client = endpoint ? this.options.clients.get(endpoint.id) : undefined;

    if (!endpoint || !endpoint.enabled || !client) {
      this.markDeliveryRetryFailed(delivery, "missing endpoint client");
      return;
    }

    this.runningDeliveries.add(delivery.id);

    try {
      const deliver = this.options.deliver ?? deliverScheduleResponse;
      await deliver(endpoint, client, delivery.target, delivery.response);
      removePendingDelivery(this.options.home, delivery.id);
      appendRuntimeLog(this.options.home, "schedule_delivery_retry_delivered", {
        schedule: delivery.scheduleId,
        endpoint: endpoint.id,
        delivery: delivery.id
      });
    } catch (error) {
      this.markDeliveryRetryFailed(delivery, errorMessage(error));
    } finally {
      this.runningDeliveries.delete(delivery.id);
    }
  }

  private markDeliveryRetryFailed(delivery: PendingDelivery, error: string): void {
    const updated = markPendingDeliveryFailed(this.options.home, delivery.id, error);
    appendRuntimeLog(this.options.home, "schedule_delivery_retry_failed", {
      schedule: delivery.scheduleId,
      endpoint: delivery.endpoint,
      delivery: delivery.id,
      attempts: updated?.attempts,
      nextRetryAt: updated?.nextRetryAt,
      error
    });
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
