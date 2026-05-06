import { describe, expect, it } from "vitest";
import { buildSchedulePlan, isBiweeklyOccurrence } from "../src/lib/schedule-plan.js";
import type { Schedule } from "../src/lib/types.js";

describe("schedule plans", () => {
  it("builds a raw cron plan", () => {
    expect(buildSchedulePlan(schedule({ kind: "cron", cron: "*/15 * * * *", timezone: "Asia/Shanghai" }))).toEqual({
      kind: "cron",
      expression: "*/15 * * * *",
      timezone: "Asia/Shanghai"
    });
  });

  it("builds an hourly cron plan", () => {
    expect(buildSchedulePlan(schedule({ kind: "hourly", minute: 15, timezone: "Asia/Shanghai" }))).toEqual({
      kind: "cron",
      expression: "15 * * * *",
      timezone: "Asia/Shanghai"
    });
  });

  it("builds a daily cron plan", () => {
    expect(buildSchedulePlan(schedule({ kind: "daily", time: "09:30", timezone: "Asia/Shanghai" }))).toEqual({
      kind: "cron",
      expression: "30 9 * * *",
      timezone: "Asia/Shanghai"
    });
  });

  it("builds a weekly cron plan", () => {
    expect(buildSchedulePlan(schedule({ kind: "weekly", weekday: "friday", time: "17:30", timezone: "Asia/Shanghai" }))).toEqual({
      kind: "cron",
      expression: "30 17 * * 5",
      timezone: "Asia/Shanghai"
    });
  });

  it("builds a biweekly weekly cron plan", () => {
    expect(
      buildSchedulePlan(schedule({ kind: "biweekly", weekday: "monday", startDate: "2026-05-04", time: "09:00", timezone: "Asia/Shanghai" }))
    ).toEqual({
      kind: "cron",
      expression: "0 9 * * 1",
      timezone: "Asia/Shanghai"
    });
  });

  it("builds a monthly cron plan", () => {
    expect(buildSchedulePlan(schedule({ kind: "monthly", day: 1, time: "09:00", timezone: "Asia/Shanghai" }))).toEqual({
      kind: "cron",
      expression: "0 9 1 * *",
      timezone: "Asia/Shanghai"
    });
  });

  it("builds a once plan", () => {
    expect(buildSchedulePlan(schedule({ kind: "once", runAt: "2026-05-10T10:00:00+08:00" }))).toEqual({
      kind: "once",
      runAt: "2026-05-10T10:00:00+08:00"
    });
  });

  it("matches biweekly occurrences from the start date anchor", () => {
    expect(isBiweeklyOccurrence("2026-05-04", new Date("2026-05-04T01:00:00.000Z"))).toBe(true);
    expect(isBiweeklyOccurrence("2026-05-04", new Date("2026-05-11T01:00:00.000Z"))).toBe(false);
    expect(isBiweeklyOccurrence("2026-05-04", new Date("2026-05-18T01:00:00.000Z"))).toBe(true);
  });

  it("matches biweekly occurrences in the schedule timezone", () => {
    expect(isBiweeklyOccurrence("2026-05-04", new Date("2026-05-03T16:30:00.000Z"), "Asia/Shanghai")).toBe(true);
  });
});

function schedule(overrides: Partial<Schedule>): Schedule {
  return {
    id: "daily-brief",
    endpoint: "discord-main",
    enabled: true,
    kind: "daily",
    time: "09:00",
    timezone: "Asia/Shanghai",
    target: "channel:123",
    message: "Generate my daily brief.",
    ...overrides
  };
}
