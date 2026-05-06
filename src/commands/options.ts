import { resolveAideHome } from "../lib/paths.js";

export interface CommandOptions {
  home?: string;
  [key: string]: unknown;
}

export function homeFromOptions(options: CommandOptions): string {
  return resolveAideHome(typeof options.home === "string" ? options.home : undefined);
}

export function stringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function booleanOption(options: Record<string, unknown>, key: string): boolean | undefined {
  const value = options[key];
  return typeof value === "boolean" ? value : undefined;
}

export function numberOption(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key];

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}
