import type { AgentRunEvent } from "./agent-tools.js";

const DETAIL_LIMIT = 80;

export function formatAgentProgress(event: AgentRunEvent, options: { redactions?: string[] } = {}): string | undefined {
  const payload = event.payload;
  const type = stringValue(payload.type) ?? event.type;

  if (type === "error") {
    return line("Codex stream error", stringValue(payload.message), options.redactions);
  }

  if (type === "turn.failed") {
    return line("Codex turn failed", nestedString(payload, ["error", "message"]), options.redactions);
  }

  const item = recordValue(payload.item);

  if (!item) {
    return undefined;
  }

  const itemType = stringValue(item.type);
  const itemStatus = stringValue(item.status);
  const status = itemStatus ? ` ${itemStatus}` : "";

  if (itemType === "command_execution") {
    const command = stringValue(item.command);
    const exitCode = numberValue(item.exit_code);

    if (type === "item.started") {
      return line("Running terminal command", command, options.redactions);
    }

    if (type === "item.completed") {
      const prefix = exitCode === undefined ? `Terminal command${status}` : `Terminal command exited ${exitCode}`;
      return line(prefix, command, options.redactions);
    }
  }

  if (itemType === "file_change") {
    const paths = fileChangePaths(item);

    if (paths.length === 0) {
      return undefined;
    }

    return line(type === "item.started" ? "Editing files" : "File edit finished", paths.join(", "), options.redactions);
  }

  if (itemType === "web_search") {
    const query = stringValue(item.query);

    if (!query) {
      return undefined;
    }

    return line(type === "item.started" ? "Searching web" : "Web search finished", query, options.redactions);
  }

  return undefined;
}

function fileChangePaths(item: Record<string, unknown>): string[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];

  return changes.flatMap((change) => {
    const record = recordValue(change);
    const path = record ? stringValue(record.path) : undefined;
    return path ? [path] : [];
  });
}

function line(prefix: string, detail: string | undefined, redactions: string[] | undefined): string {
  const cleanDetail = truncate(redact(singleLine(detail ?? ""), redactions), DETAIL_LIMIT);
  return cleanDetail ? `${prefix}: ${cleanDetail}` : `${prefix}.`;
}

function redact(value: string, redactions: string[] | undefined): string {
  let result = value;

  for (const secret of redactions ?? []) {
    if (secret.length > 0) {
      result = result.split(secret).join("[redacted]");
    }
  }

  return result;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, limit - 3)}...`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function nestedString(value: Record<string, unknown>, keys: string[]): string | undefined {
  let current: unknown = value;

  for (const key of keys) {
    const record = recordValue(current);

    if (!record) {
      return undefined;
    }

    current = record[key];
  }

  return stringValue(current);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
