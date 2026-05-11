import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertInitialized, readJson } from "./config.js";
import { pendingDeliveriesPath } from "./paths.js";

const DELIVERY_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

const pendingDeliverySchema = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  endpoint: z.string().min(1),
  target: z.string().min(1),
  response: z.string(),
  attempts: z.number().int().min(1),
  nextRetryAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastError: z.string().optional()
});

const pendingDeliveriesFileSchema = z.object({
  deliveries: z.array(pendingDeliverySchema).default([])
});

export type PendingDelivery = z.infer<typeof pendingDeliverySchema>;

export interface PendingDeliveryInput {
  scheduleId: string;
  endpoint: string;
  target: string;
  response: string;
}

export function loadPendingDeliveries(home: string): PendingDelivery[] {
  assertInitialized(home);
  return pendingDeliveriesFileSchema.parse(readJson(pendingDeliveriesPath(home), { deliveries: [] })).deliveries;
}

export function duePendingDeliveries(home: string, now = new Date()): PendingDelivery[] {
  const nowTime = now.getTime();
  return loadPendingDeliveries(home).filter((delivery) => new Date(delivery.nextRetryAt).getTime() <= nowTime);
}

export function addPendingDelivery(
  home: string,
  input: PendingDeliveryInput,
  error: string,
  now = new Date()
): PendingDelivery {
  const deliveries = loadPendingDeliveries(home);
  const createdAt = now.toISOString();
  const delivery: PendingDelivery = {
    id: randomUUID(),
    scheduleId: input.scheduleId,
    endpoint: input.endpoint,
    target: input.target,
    response: input.response,
    attempts: 1,
    nextRetryAt: retryAt(1, now),
    createdAt,
    updatedAt: createdAt,
    lastError: error
  };

  writePendingDeliveries(home, [...deliveries, delivery]);
  return delivery;
}

export function markPendingDeliveryFailed(
  home: string,
  id: string,
  error: string,
  now = new Date()
): PendingDelivery | undefined {
  const deliveries = loadPendingDeliveries(home);
  const next = deliveries.map((delivery) => {
    if (delivery.id !== id) {
      return delivery;
    }

    const attempts = delivery.attempts + 1;
    return {
      ...delivery,
      attempts,
      nextRetryAt: retryAt(attempts, now),
      updatedAt: now.toISOString(),
      lastError: error
    };
  });

  writePendingDeliveries(home, next);
  return next.find((delivery) => delivery.id === id);
}

export function removePendingDelivery(home: string, id: string): void {
  writePendingDeliveries(home, loadPendingDeliveries(home).filter((delivery) => delivery.id !== id));
}

function writePendingDeliveries(home: string, deliveries: PendingDelivery[]): void {
  const body = pendingDeliveriesFileSchema.parse({ deliveries });
  fs.writeFileSync(pendingDeliveriesPath(home), `${JSON.stringify(body, null, 2)}\n`);
}

function retryAt(attempts: number, now: Date): string {
  const delay = DELIVERY_RETRY_DELAYS_MS[Math.min(attempts - 1, DELIVERY_RETRY_DELAYS_MS.length - 1)] ?? 60_000;
  return new Date(now.getTime() + delay).toISOString();
}
