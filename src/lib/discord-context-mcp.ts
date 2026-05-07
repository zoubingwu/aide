import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { ManagedAgentToolServer } from "./agent-tools.js";
import {
  DiscordContextError,
  DiscordContextReader,
  type DiscordContextReaderOptions
} from "./discord-context.js";
import { appendRuntimeLog } from "./logging.js";

export const DISCORD_CONTEXT_TOOL_SERVER = "aide-discord-context";

type DiscordContextToolName =
  | "discord_get_recent_messages"
  | "discord_get_referenced_message"
  | "discord_get_thread_context"
  | "discord_search_recent_messages";

export interface StartDiscordContextToolServerInput extends DiscordContextReaderOptions {
  home: string;
}

export interface DiscordContextToolLog {
  toolName: string;
  requestedSource?: string | undefined;
  resultCount: number;
  durationMs: number;
  errorCode?: string | undefined;
}

export type DiscordContextToolLogger = (event: DiscordContextToolLog) => void;

export async function startDiscordContextToolServer(input: StartDiscordContextToolServerInput): Promise<ManagedAgentToolServer> {
  const reader = new DiscordContextReader(input);
  const httpServer = http.createServer((req, res) => {
    void handleMcpHttpRequest(input, reader, req, res);
  });

  await listen(httpServer);
  const address = httpServer.address();

  if (!address || typeof address === "string") {
    await closeServer(httpServer);
    throw new Error("Discord context MCP server did not bind to a TCP port.");
  }

  return {
    name: DISCORD_CONTEXT_TOOL_SERVER,
    url: `http://127.0.0.1:${address.port}/mcp`,
    stop: () => closeServer(httpServer)
  };
}

export function createDiscordContextMcpServer(reader: DiscordContextReader, logger?: DiscordContextToolLogger): McpServer {
  const server = new McpServer(
    { name: DISCORD_CONTEXT_TOOL_SERVER, version: "1.0.0" },
    {
      instructions:
        "Use these tools only when the current Discord request needs nearby channel, reply, or thread context. Results are scoped to the triggering Discord source."
    }
  );

  server.registerTool(
    "discord_get_recent_messages",
    {
      description: "Read recent messages from the current Discord channel, thread, or DM.",
      inputSchema: {
        source: z.string(),
        limit: z.number().int().min(1).max(100).optional(),
        beforeMessageId: z.string().optional()
      }
    },
    (input) => runDiscordContextTool(reader, "discord_get_recent_messages", input, logger)
  );

  server.registerTool(
    "discord_get_referenced_message",
    {
      description: "Read the Discord message referenced by the current reply.",
      inputSchema: {
        source: z.string()
      }
    },
    (input) => runDiscordContextTool(reader, "discord_get_referenced_message", input, logger)
  );

  server.registerTool(
    "discord_get_thread_context",
    {
      description: "Read the current Discord thread starter and recent thread messages.",
      inputSchema: {
        threadId: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional()
      }
    },
    (input) => runDiscordContextTool(reader, "discord_get_thread_context", input, logger)
  );

  server.registerTool(
    "discord_search_recent_messages",
    {
      description: "Search recent visible Discord messages inside the current source.",
      inputSchema: {
        source: z.string(),
        query: z.string(),
        limit: z.number().int().min(1).max(50).optional(),
        lookback: z.string().optional()
      }
    },
    (input) => runDiscordContextTool(reader, "discord_search_recent_messages", input, logger)
  );

  return server;
}

export async function runDiscordContextTool(
  reader: DiscordContextReader,
  toolName: string,
  input: Record<string, unknown>,
  logger?: DiscordContextToolLogger
): Promise<CallToolResult> {
  const startedAt = Date.now();
  let resultCount = 0;
  let errorCode: string | undefined;

  try {
    const output = await callDiscordContextTool(reader, toolName as DiscordContextToolName, input);
    resultCount = discordContextResultCount(output);
    return jsonToolResult(output);
  } catch (error) {
    errorCode = discordContextErrorCode(error);
    return errorToolResult(error);
  } finally {
    logger?.({
      toolName,
      requestedSource: optionalString(input.source),
      resultCount,
      durationMs: Date.now() - startedAt,
      errorCode
    });
  }
}

async function handleMcpHttpRequest(
  input: StartDiscordContextToolServerInput,
  reader: DiscordContextReader,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (!isAllowedLocalhostRequest(req)) {
    writeJson(res, 403, { jsonrpc: "2.0", error: { code: -32000, message: "Forbidden host." }, id: null });
    return;
  }

  if (req.method !== "POST" || req.url !== "/mcp") {
    writeJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    return;
  }

  const server = createDiscordContextMcpServer(reader, (event) => {
    appendRuntimeLog(input.home, "discord_context_tool_call", {
      endpoint: input.request.endpointId,
      source: input.request.source,
      ...event
    });
  });
  const transportOptions = {
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0];
  const transport = new StreamableHTTPServerTransport(transportOptions);

  try {
    const body = await readJsonBody(req);
    await server.connect(transport as never);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    appendRuntimeLog(input.home, "discord_context_tool_http_failed", {
      endpoint: input.request.endpointId,
      source: input.request.source,
      error: error instanceof Error ? error.message : String(error)
    });

    if (!res.headersSent) {
      writeJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  } finally {
    await transport.close();
    await server.close();
  }
}

async function callDiscordContextTool(reader: DiscordContextReader, toolName: DiscordContextToolName, input: Record<string, unknown>): Promise<unknown> {
  switch (toolName) {
    case "discord_get_recent_messages":
      return reader.getRecentMessages({
        source: String(input.source),
        limit: optionalNumber(input.limit),
        beforeMessageId: optionalString(input.beforeMessageId)
      });
    case "discord_get_referenced_message":
      return reader.getReferencedMessage({ source: String(input.source) });
    case "discord_get_thread_context":
      return reader.getThreadContext({
        threadId: optionalString(input.threadId),
        limit: optionalNumber(input.limit)
      });
    case "discord_search_recent_messages":
      return reader.searchRecentMessages({
        source: String(input.source),
        query: String(input.query),
        limit: optionalNumber(input.limit),
        lookback: optionalString(input.lookback)
      });
    default:
      throw new DiscordContextError("unsupported_source", `Unsupported Discord context tool: ${toolName}`);
  }
}

function jsonToolResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  };
}

function errorToolResult(error: unknown): CallToolResult {
  const payload = error instanceof DiscordContextError
    ? { code: error.code, message: error.message }
    : { code: "not_found", message: error instanceof Error ? error.message : String(error) };

  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}

function discordContextResultCount(value: unknown): number {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (value && typeof value === "object" && "messages" in value && Array.isArray((value as { messages: unknown }).messages)) {
    return (value as { messages: unknown[] }).messages.length;
  }

  return value ? 1 : 0;
}

function discordContextErrorCode(error: unknown): string | undefined {
  return error instanceof DiscordContextError ? error.code : "not_found";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
}

function isAllowedLocalhostRequest(req: http.IncomingMessage): boolean {
  const host = req.headers.host;
  return host === undefined || host.startsWith("127.0.0.1:");
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body.length > 0 ? JSON.parse(body) : undefined;
}

function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
