const DISCORD_MESSAGE_CONTENT_LIMIT = 2_000;
const DISCORD_MESSAGE_CHUNK_BUFFER = 100;
const DISCORD_MESSAGE_CHUNK_SIZE = DISCORD_MESSAGE_CONTENT_LIMIT - DISCORD_MESSAGE_CHUNK_BUFFER;
const MARKDOWN_FENCE_MARKER_REOPEN_LIMIT = 80;
const MARKDOWN_FENCE_INFO_REOPEN_LIMIT = 80;
const MARKDOWN_NESTED_FENCE_ESCAPE = "\u200B";
const MARKDOWN_CODE_FENCE_LANGUAGES = new Set(["markdown", "md", "mdx"]);

interface MarkdownFenceState {
  marker: string;
  info: string;
}

interface MarkdownFenceLine {
  marker: string;
  info: string;
}

export function chunkDiscordMessage(response: string): string[] {
  const content = escapeNestedDiscordMarkdownFences(response);

  if (content.length <= DISCORD_MESSAGE_CONTENT_LIMIT) {
    return [content];
  }

  const chunks: string[] = [];
  let fenceState: MarkdownFenceState | undefined;
  let index = 0;

  while (index < content.length) {
    const prefix = fenceState ? openMarkdownFence(fenceState) : "";
    let bodyLimit = Math.max(1, DISCORD_MESSAGE_CHUNK_SIZE - prefix.length);
    let chunk = "";
    let nextIndex = index;
    let nextFenceState: MarkdownFenceState | undefined;

    while (chunk.length === 0 || (chunk.length > DISCORD_MESSAGE_CONTENT_LIMIT && bodyLimit > 1)) {
      nextIndex = findDiscordChunkEnd(content, index, bodyLimit);

      const body = content.slice(index, nextIndex);
      nextFenceState = scanMarkdownFenceState(body, fenceState);
      chunk = `${prefix}${body}${nextFenceState ? closeMarkdownFence(body, nextFenceState) : ""}`;

      if (chunk.length > DISCORD_MESSAGE_CONTENT_LIMIT) {
        bodyLimit = Math.max(1, bodyLimit - (chunk.length - DISCORD_MESSAGE_CONTENT_LIMIT));
      }
    }

    chunks.push(chunk);
    index = nextIndex;
    fenceState = nextFenceState;
  }

  return chunks;
}

function escapeNestedDiscordMarkdownFences(response: string): string {
  const lines = response.split("\n");
  let markdownFence: MarkdownFenceLine | undefined;
  let nestedFence: MarkdownFenceLine | undefined;
  let changed = false;

  const escaped = lines.map((rawLine, index) => {
    const { line, suffix } = splitLineSuffix(rawLine);
    const fenceLine = parseMarkdownFenceLine(line);

    if (!markdownFence) {
      if (fenceLine && isMarkdownFenceLanguage(fenceLine.info)) {
        markdownFence = fenceLine;
      }
      return rawLine;
    }

    if (!fenceLine) {
      return rawLine;
    }

    if (nestedFence) {
      if (!isClosingFenceFor(fenceLine, markdownFence)) {
        return rawLine;
      }

      if (isClosingFenceFor(fenceLine, nestedFence) && isClosingMarkdownFenceLine(line)) {
        nestedFence = undefined;
      }
      changed = true;
      return `${escapeMarkdownFenceLine(line)}${suffix}`;
    }

    if (isClosingFenceFor(fenceLine, markdownFence) && isClosingMarkdownFenceLine(line)) {
      if (hasUnlabeledNestedFenceClose(lines, index, markdownFence)) {
        nestedFence = fenceLine;
        changed = true;
        return `${escapeMarkdownFenceLine(line)}${suffix}`;
      }

      markdownFence = undefined;
      return rawLine;
    }

    if (!isClosingFenceFor(fenceLine, markdownFence)) {
      return rawLine;
    }

    nestedFence = isClosingMarkdownFenceLine(line) ? undefined : fenceLine;
    changed = true;
    return `${escapeMarkdownFenceLine(line)}${suffix}`;
  });

  return changed ? escaped.join("\n") : response;
}

function hasUnlabeledNestedFenceClose(lines: string[], index: number, markdownFence: MarkdownFenceLine): boolean {
  if (!hasUnlabeledNestedFenceIntro(lines, index)) {
    return false;
  }

  if (!hasImmediateNestedFenceBody(lines, index, markdownFence)) {
    return false;
  }

  const innerCloseIndex = findClosingMarkdownFenceIndex(lines, index + 1, markdownFence);

  if (innerCloseIndex === undefined) {
    return false;
  }

  return findClosingMarkdownFenceIndex(lines, innerCloseIndex + 1, markdownFence) !== undefined;
}

function hasUnlabeledNestedFenceIntro(lines: string[], index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const rawLine = lines[cursor] ?? "";
    const { line } = splitLineSuffix(rawLine);
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    return isUnlabeledNestedFenceIntroLine(trimmed);
  }

  return false;
}

function isUnlabeledNestedFenceIntroLine(line: string): boolean {
  return !/^(#{1,6}\s|`{3,}|~{3,})/.test(line);
}

function hasImmediateNestedFenceBody(lines: string[], index: number, markdownFence: MarkdownFenceLine): boolean {
  const rawLine = lines[index + 1];

  if (rawLine === undefined) {
    return false;
  }

  const { line } = splitLineSuffix(rawLine);
  const fenceLine = parseMarkdownFenceLine(line);

  if (line.trim().length === 0) {
    return false;
  }

  return !(fenceLine && isClosingMarkdownFenceLine(line) && isClosingFenceFor(fenceLine, markdownFence));
}

function findClosingMarkdownFenceIndex(
  lines: string[],
  startIndex: number,
  markdownFence: MarkdownFenceLine
): number | undefined {
  for (let cursor = startIndex; cursor < lines.length; cursor += 1) {
    const rawLine = lines[cursor] ?? "";
    const { line } = splitLineSuffix(rawLine);
    const fenceLine = parseMarkdownFenceLine(line);

    if (fenceLine && isClosingMarkdownFenceLine(line) && isClosingFenceFor(fenceLine, markdownFence)) {
      return cursor;
    }
  }

  return undefined;
}

function splitLineSuffix(rawLine: string): { line: string; suffix: string } {
  return rawLine.endsWith("\r")
    ? { line: rawLine.slice(0, -1), suffix: "\r" }
    : { line: rawLine, suffix: "" };
}

function parseMarkdownFenceLine(line: string): MarkdownFenceLine | undefined {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);

  if (!match) {
    return undefined;
  }

  return {
    marker: match[1] ?? "",
    info: (match[2] ?? "").trim()
  };
}

function isMarkdownFenceLanguage(info: string): boolean {
  const language = info.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return MARKDOWN_CODE_FENCE_LANGUAGES.has(language);
}

function isClosingFenceFor(line: MarkdownFenceLine, state: MarkdownFenceLine): boolean {
  return line.marker.startsWith(state.marker.slice(0, 1)) && line.marker.length >= state.marker.length;
}

function isClosingMarkdownFenceLine(line: string): boolean {
  return /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.test(line);
}

function escapeMarkdownFenceLine(line: string): string {
  return line.replace(
    /^([ \t]{0,3})(`{3,}|~{3,})/,
    (_match, indent: string, marker: string) => `${indent}${marker[0]}${MARKDOWN_NESTED_FENCE_ESCAPE}${marker.slice(1)}`
  );
}

function findDiscordChunkEnd(response: string, start: number, limit: number): number {
  const hardEnd = Math.min(response.length, start + limit);

  if (hardEnd >= response.length) {
    return response.length;
  }

  const minimumEnd = start + Math.max(1, Math.floor(limit * 0.6));

  return findLastBreak(response, "\n\n", start, minimumEnd, hardEnd)
    ?? findLastBreak(response, "\n", start, minimumEnd, hardEnd)
    ?? findLastBreak(response, " ", start, minimumEnd, hardEnd)
    ?? hardEnd;
}

function findLastBreak(response: string, token: string, start: number, minimumEnd: number, hardEnd: number): number | undefined {
  const index = response.lastIndexOf(token, hardEnd - token.length);
  const end = index + token.length;

  if (index < start || end < minimumEnd || end <= start) {
    return undefined;
  }

  return end;
}

function scanMarkdownFenceState(text: string, initialState: MarkdownFenceState | undefined): MarkdownFenceState | undefined {
  let state = initialState;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    state = nextMarkdownFenceState(line, state);
  }

  return state;
}

function nextMarkdownFenceState(line: string, state: MarkdownFenceState | undefined): MarkdownFenceState | undefined {
  if (state) {
    return isClosingMarkdownFence(line, state) ? undefined : state;
  }

  return parseOpeningMarkdownFence(line);
}

function parseOpeningMarkdownFence(line: string): MarkdownFenceState | undefined {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);

  if (!match) {
    return undefined;
  }

  const marker = match[1] ?? "";
  const info = (match[2] ?? "").trimEnd();

  if (marker.length === 0) {
    return undefined;
  }

  if (marker.length > MARKDOWN_FENCE_MARKER_REOPEN_LIMIT) {
    return undefined;
  }

  if (marker.startsWith("`") && info.includes("`")) {
    return undefined;
  }

  return { marker, info: reopenMarkdownFenceInfo(info) };
}

function isClosingMarkdownFence(line: string, state: MarkdownFenceState): boolean {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
  const marker = match?.[1];

  return Boolean(marker && marker.startsWith(state.marker.slice(0, 1)) && marker.length >= state.marker.length);
}

function openMarkdownFence(state: MarkdownFenceState): string {
  return `${state.marker}${state.info}\n`;
}

function closeMarkdownFence(body: string, state: MarkdownFenceState): string {
  return `${body.endsWith("\n") ? "" : "\n"}${state.marker}`;
}

function reopenMarkdownFenceInfo(info: string): string {
  return info.length <= MARKDOWN_FENCE_INFO_REOPEN_LIMIT ? info : "";
}
