import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAideHome } from "../src/lib/config.js";
import {
  addPendingDelivery,
  duePendingDeliveries,
  loadPendingDeliveries,
  markPendingDeliveryFailed,
  removePendingDelivery
} from "../src/lib/delivery-retries.js";
import { pendingDeliveriesPath } from "../src/lib/paths.js";

const cleanupPaths: string[] = [];

describe("delivery retries", () => {
  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("persists pending deliveries and selects due entries", () => {
    const home = tempHome();
    ensureAideHome(home);
    const now = new Date("2026-05-10T10:00:00.000Z");

    const delivery = addPendingDelivery(home, {
      scheduleId: "daily-brief",
      endpoint: "discord-main",
      target: "channel:123",
      response: "done"
    }, "network down", now);

    if (process.platform !== "win32") {
      expect(fs.statSync(pendingDeliveriesPath(home)).mode & 0o777).toBe(0o600);
    }
    expect(pendingDeliveriesPath(home)).toBe(path.join(home, "state", "pending-deliveries.json"));
    expect(loadPendingDeliveries(home)).toMatchObject([
      {
        id: delivery.id,
        scheduleId: "daily-brief",
        endpoint: "discord-main",
        target: "channel:123",
        response: "done",
        attempts: 1,
        nextRetryAt: "2026-05-10T10:01:00.000Z",
        lastError: "network down"
      }
    ]);
    expect(duePendingDeliveries(home, new Date("2026-05-10T10:00:59.999Z"))).toEqual([]);
    expect(duePendingDeliveries(home, new Date("2026-05-10T10:01:00.000Z"))).toHaveLength(1);
  });

  it("backs off failed delivery retries and removes successful deliveries", () => {
    const home = tempHome();
    ensureAideHome(home);
    const delivery = addPendingDelivery(home, {
      scheduleId: "daily-brief",
      endpoint: "discord-main",
      target: "channel:123",
      response: "done"
    }, "network down", new Date("2026-05-10T10:00:00.000Z"));
    if (process.platform !== "win32") {
      fs.chmodSync(pendingDeliveriesPath(home), 0o644);
    }

    const updated = markPendingDeliveryFailed(home, delivery.id, "still down", new Date("2026-05-10T10:01:00.000Z"));

    expect(updated).toMatchObject({
      id: delivery.id,
      attempts: 2,
      nextRetryAt: "2026-05-10T10:06:00.000Z",
      lastError: "still down"
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(pendingDeliveriesPath(home)).mode & 0o777).toBe(0o600);
    }

    removePendingDelivery(home, delivery.id);
    expect(loadPendingDeliveries(home)).toEqual([]);
  });
});

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-delivery-retries-"));
  cleanupPaths.push(target);
  return target;
}
