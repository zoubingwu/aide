import { describe, expect, it } from "vitest";
import { parseDiscordTarget } from "../src/lib/discord-delivery.js";

describe("discord delivery", () => {
  it("parses channel targets", () => {
    expect(parseDiscordTarget("channel:123")).toEqual({ kind: "channel", id: "123" });
  });

  it("parses user targets", () => {
    expect(parseDiscordTarget("user:987")).toEqual({ kind: "user", id: "987" });
  });

  it("rejects unsupported targets", () => {
    expect(() => parseDiscordTarget("thread:456")).toThrow("Unsupported Discord target: thread:456");
  });
});
