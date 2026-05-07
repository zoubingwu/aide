import type { Message } from "discord.js";
import type { AssistantPromptMetadata } from "./agent.js";
import type { Endpoint } from "./types.js";

export type DiscordAuthorKind = "user" | "bot" | "system";

export interface DiscordAttachmentRecord {
  id: string;
  name: string;
  url: string;
  contentType?: string | undefined;
}

export interface DiscordMessageRecord {
  id: string;
  authorId: string;
  authorName: string;
  authorKind: DiscordAuthorKind;
  timestamp: string;
  content: string;
  channelId: string;
  threadId?: string | undefined;
  replyToMessageId?: string | undefined;
  attachments: DiscordAttachmentRecord[];
}

export interface DiscordRequestContext {
  endpointId: string;
  source: string;
  messageId: string;
  authorId: string;
  guildId?: string | undefined;
  channelId: string;
  threadId?: string | undefined;
  replyToMessageId?: string | undefined;
}

export function buildDiscordRequestContext(endpoint: Endpoint, message: Message): DiscordRequestContext {
  const threadId = discordThreadId(message);
  const channelId = threadId ? discordParentChannelId(message) : message.channelId;
  const guildId = message.guildId ?? undefined;
  const replyToMessageId = message.reference?.messageId ?? undefined;

  return {
    endpointId: endpoint.id,
    source: guildId ? `channel:${message.channelId}` : `user:${message.author.id}`,
    messageId: message.id,
    authorId: message.author.id,
    guildId,
    channelId,
    threadId,
    replyToMessageId
  };
}

export function buildDiscordPromptMetadata(context: DiscordRequestContext): AssistantPromptMetadata[] {
  return [
    { label: "Discord Message ID", value: context.messageId },
    { label: "Discord Guild ID", value: context.guildId },
    { label: "Discord Channel ID", value: context.channelId },
    { label: "Discord Thread ID", value: context.threadId },
    { label: "Discord Reply To", value: context.replyToMessageId }
  ];
}

export function normalizeDiscordMessage(message: Message): DiscordMessageRecord {
  return {
    id: message.id,
    authorId: message.author.id,
    authorName: message.author.username,
    authorKind: discordAuthorKind(message),
    timestamp: new Date(message.createdTimestamp).toISOString(),
    content: message.content ?? "",
    channelId: message.channelId,
    threadId: discordThreadId(message),
    replyToMessageId: message.reference?.messageId ?? undefined,
    attachments: Array.from(message.attachments.values()).map((attachment) => ({
      id: attachment.id,
      name: attachment.name ?? attachment.id,
      url: attachment.url,
      contentType: attachment.contentType ?? undefined
    }))
  };
}

export function clampDiscordLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || value < 1) {
    return fallback;
  }

  return Math.min(Math.floor(value), maximum);
}

export type DiscordContextErrorCode = "permission_denied" | "not_found" | "unsupported_source" | "rate_limited";

export class DiscordContextError extends Error {
  constructor(
    public readonly code: DiscordContextErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface GetRecentMessagesInput {
  source: string;
  limit?: number | undefined;
  beforeMessageId?: string | undefined;
}

export interface GetReferencedMessageInput {
  source: string;
}

export interface GetThreadContextInput {
  threadId?: string | undefined;
  limit?: number | undefined;
}

export interface SearchRecentMessagesInput {
  source: string;
  query: string;
  limit?: number | undefined;
  lookback?: string | undefined;
}

export interface DiscordThreadContext {
  threadId: string;
  parentChannelId?: string | undefined;
  starterMessage?: DiscordMessageRecord | undefined;
  messages: DiscordMessageRecord[];
}

interface DiscordFetchableChannel {
  id: string;
  parentId?: string | null | undefined;
  messages: {
    fetch(input: unknown): Promise<unknown>;
  };
  fetchStarterMessage?: () => Promise<unknown>;
}

export interface DiscordContextReaderOptions {
  request: DiscordRequestContext;
  channel: Message["channel"];
  now?: (() => Date) | undefined;
}

export class DiscordContextReader {
  private readonly now: () => Date;

  constructor(private readonly options: DiscordContextReaderOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async getRecentMessages(input: GetRecentMessagesInput): Promise<DiscordMessageRecord[]> {
    this.assertSource(input.source);
    const limit = clampDiscordLimit(input.limit, 20, 100);
    const messages = await this.fetchMessageList({ limit, before: input.beforeMessageId });
    return messages.map(normalizeDiscordMessage).reverse();
  }

  async getReferencedMessage(input: GetReferencedMessageInput): Promise<DiscordMessageRecord | undefined> {
    this.assertSource(input.source);
    const replyToMessageId = this.options.request.replyToMessageId;

    if (!replyToMessageId) {
      return undefined;
    }

    const message = await this.fetchSingleMessage(replyToMessageId);
    return normalizeDiscordMessage(message);
  }

  async getThreadContext(input: GetThreadContextInput): Promise<DiscordThreadContext> {
    const threadId = input.threadId ?? this.options.request.threadId;

    if (!threadId || threadId !== this.options.request.threadId) {
      throw new DiscordContextError("permission_denied", "Thread is outside the current request scope.");
    }

    const limit = clampDiscordLimit(input.limit, 50, 100);
    const messages = (await this.fetchMessageList({ limit })).map(normalizeDiscordMessage).reverse();
    const starterMessage = await this.fetchStarterMessage();

    return {
      threadId,
      parentChannelId: fetchableChannel(this.options.channel).parentId ?? this.options.request.channelId,
      starterMessage: starterMessage ? normalizeDiscordMessage(starterMessage) : undefined,
      messages
    };
  }

  async searchRecentMessages(input: SearchRecentMessagesInput): Promise<DiscordMessageRecord[]> {
    this.assertSource(input.source);
    const query = input.query.trim().toLowerCase();

    if (query.length === 0) {
      return [];
    }

    const limit = clampDiscordLimit(input.limit, 20, 50);
    const since = this.lookbackStart(input.lookback);
    const messages = await this.fetchMessageList({ limit: 100 });

    return messages
      .map(normalizeDiscordMessage)
      .filter((record) => Date.parse(record.timestamp) >= since.getTime())
      .filter((record) => record.content.toLowerCase().includes(query))
      .reverse()
      .slice(0, limit);
  }

  private assertSource(source: string): void {
    if (source !== this.options.request.source) {
      throw new DiscordContextError("permission_denied", "Requested source is outside the current request scope.");
    }
  }

  private async fetchMessageList(input: { limit: number; before?: string | undefined }): Promise<Message[]> {
    try {
      const result = await fetchableChannel(this.options.channel).messages.fetch(input);
      return Array.from((result as Map<string, Message>).values());
    } catch (error) {
      throw mapDiscordFetchError(error);
    }
  }

  private async fetchSingleMessage(messageId: string): Promise<Message> {
    try {
      return (await fetchableChannel(this.options.channel).messages.fetch(messageId)) as Message;
    } catch (error) {
      throw mapDiscordFetchError(error);
    }
  }

  private async fetchStarterMessage(): Promise<Message | undefined> {
    const channel = fetchableChannel(this.options.channel);

    if (!channel.fetchStarterMessage) {
      return undefined;
    }

    try {
      return (await channel.fetchStarterMessage()) as Message;
    } catch {
      return undefined;
    }
  }

  private lookbackStart(value: string | undefined): Date {
    const hours = parseLookbackHours(value ?? "24h");
    return new Date(this.now().getTime() - hours * 60 * 60 * 1000);
  }
}

function parseLookbackHours(value: string): number {
  const match = /^(\d+)(h|d)$/.exec(value.trim());

  if (!match) {
    return 24;
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const hours = unit === "d" ? amount * 24 : amount;
  return Math.min(Math.max(hours, 1), 30 * 24);
}

function mapDiscordFetchError(error: unknown): DiscordContextError {
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : undefined;

  if (status === 403) {
    return new DiscordContextError("permission_denied", "Discord denied access to the requested context.");
  }

  if (status === 404) {
    return new DiscordContextError("not_found", "Discord context was unavailable.");
  }

  if (status === 429) {
    return new DiscordContextError("rate_limited", "Discord rate limited the context request.");
  }

  return new DiscordContextError("not_found", error instanceof Error ? error.message : String(error));
}

function fetchableChannel(channel: Message["channel"]): DiscordFetchableChannel {
  return channel as Message["channel"] & DiscordFetchableChannel;
}

function discordAuthorKind(message: Message): DiscordAuthorKind {
  if (message.system) {
    return "system";
  }

  return message.author.bot ? "bot" : "user";
}

function discordThreadId(message: Message): string | undefined {
  return isThreadChannel(message.channel) ? message.channelId : undefined;
}

function discordParentChannelId(message: Message): string {
  const channel = message.channel as Message["channel"] & { parentId?: string | null };
  return channel.parentId ?? message.channelId;
}

function isThreadChannel(channel: Message["channel"] | undefined): boolean {
  if (!channel) {
    return false;
  }

  return "isThread" in channel && typeof channel.isThread === "function" && channel.isThread();
}
