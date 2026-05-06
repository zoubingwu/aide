import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discordTokenEnvKey, resolveDiscordToken, writeDiscordToken } from "../src/lib/secrets.js";
import type { Endpoint } from "../src/lib/types.js";

const cleanupPaths: string[] = [];

describe("secrets", () => {
  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("stores and resolves endpoint-specific Discord tokens", () => {
    const home = tempHome();
    const endpoint = makeEndpoint();

    const key = writeDiscordToken(home, endpoint.id, "abc 123");

    expect(key).toBe(discordTokenEnvKey(endpoint.id));
    expect(resolveDiscordToken(home, endpoint)).toBe("abc 123");
  });
});

function tempHome(): string {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "aide-secrets-"));
  cleanupPaths.push(target);
  return target;
}

function makeEndpoint(): Endpoint {
  return {
    id: "discord-agent-ops",
    provider: "discord",
    enabled: true
  };
}
