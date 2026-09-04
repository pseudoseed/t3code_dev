import type {
  EnvironmentId,
  TerminalAttachStreamEvent,
  TerminalMetadataStreamEvent,
  TerminalSessionSnapshot,
  TerminalSummary,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Position of a renderer within the output stream. Renderers keep their own
 * scrollback, so they only ever need the slice they have not consumed yet;
 * comparing whole buffers to find that slice is what made large sessions crawl.
 *
 * `cursor` counts UTF-16 units appended since the last `epoch` bump and `trimmed`
 * counts the units dropped off the front, so `buffer.length === cursor - trimmed`
 * always holds and the undelivered slice is `buffer.slice(delivered - trimmed)`.
 */
export interface TerminalBufferCursor {
  readonly cursor: number;
  readonly epoch: number;
}

export interface TerminalSessionState extends TerminalBufferCursor {
  readonly summary: TerminalSummary | null;
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly version: number;
  readonly trimmed: number;
}

export interface TerminalBufferState extends TerminalBufferCursor {
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly version: number;
  readonly trimmed: number;
  /** UTF-8 size of `buffer`, carried forward so trimming only encodes when it must. */
  readonly bytes: number;
}

export interface KnownTerminalSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface KnownTerminalSession {
  readonly target: KnownTerminalSessionTarget;
  readonly state: TerminalSessionState;
}

export function selectRunningSubprocessTerminalIds(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<string> {
  return sessions
    .filter((session) => session.state.hasRunningSubprocess)
    .map((session) => session.target.terminalId);
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  buffer: "",
  status: "closed",
  error: null,
  updatedAt: null,
  version: 0,
  cursor: 0,
  trimmed: 0,
  epoch: 0,
  bytes: 0,
});

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  summary: null,
  buffer: "",
  status: "closed",
  error: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  version: 0,
  cursor: 0,
  trimmed: 0,
  epoch: 0,
});

export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;
/**
 * Trimming rewrites the whole buffer, so it drops well under the cap instead of
 * shaving each new chunk off the front. Output then runs cap-to-target bytes
 * between rewrites rather than paying for one on every chunk.
 */
const TERMINAL_BUFFER_TRIM_TARGET_RATIO = 0.75;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface TrimmedBuffer {
  readonly buffer: string;
  readonly bytes: number;
  /** UTF-16 units removed from the front. */
  readonly dropped: number;
}

function trimBufferToBytes(buffer: string, bytes: number, maxBufferBytes: number): TrimmedBuffer {
  if (maxBufferBytes <= 0) {
    return { buffer: "", bytes: 0, dropped: buffer.length };
  }
  if (bytes <= maxBufferBytes) {
    return { buffer, bytes, dropped: 0 };
  }

  const encoded = textEncoder.encode(buffer);
  const target = Math.max(1, Math.floor(maxBufferBytes * TERMINAL_BUFFER_TRIM_TARGET_RATIO));
  const aligned = encoded.byteLength - target;
  const isContinuation = (offset: number) => {
    const byte = encoded[offset];
    return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000;
  };

  let start = aligned;
  while (start < encoded.length && isContinuation(start)) {
    start += 1;
  }
  if (start >= encoded.length) {
    // The target landed inside the final codepoint, so aligning forward threw it
    // away. Keep it instead whenever the whole codepoint still fits under the cap.
    let back = aligned;
    while (back > 0 && isContinuation(back)) {
      back -= 1;
    }
    if (encoded.byteLength - back <= maxBufferBytes) {
      start = back;
    }
  }

  const trimmed = textDecoder.decode(encoded.subarray(start));
  return {
    buffer: trimmed,
    bytes: encoded.byteLength - start,
    dropped: buffer.length - trimmed.length,
  };
}

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
  epoch: number,
): TerminalBufferState {
  const history = snapshot.history;
  const trimmed = trimBufferToBytes(history, utf8Length(history), maxBufferBytes);
  return {
    buffer: trimmed.buffer,
    status: snapshot.status,
    error: null,
    updatedAt: snapshot.updatedAt,
    version: 1,
    cursor: trimmed.buffer.length,
    trimmed: 0,
    epoch,
    bytes: trimmed.bytes,
  };
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function combineTerminalSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState {
  return {
    summary,
    buffer: buffer.buffer,
    status: buffer.version > 0 ? buffer.status : (summary?.status ?? buffer.status),
    error: buffer.error,
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    updatedAt: latestTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    version: buffer.version,
    cursor: buffer.cursor,
    trimmed: buffer.trimmed,
    epoch: buffer.epoch,
  };
}

export interface TerminalBufferDelta {
  /** The renderer must clear its screen and scrollback before writing `chunk`. */
  readonly reset: boolean;
  readonly chunk: string;
  /** Cursor the renderer has consumed once it writes `chunk`. */
  readonly cursor: number;
  readonly epoch: number;
}

/**
 * Slice a renderer has not written yet, given where it left off. A renderer that
 * fell behind past the trim point cannot be caught up incrementally, so it is
 * told to reset and replay what survives.
 */
export function terminalBufferDelta(
  state: {
    readonly buffer: string;
    readonly cursor: number;
    readonly trimmed: number;
    readonly epoch: number;
  },
  delivered: TerminalBufferCursor | null,
): TerminalBufferDelta {
  const consumed = { reset: false, cursor: state.cursor, epoch: state.epoch };
  if (
    delivered === null ||
    delivered.epoch !== state.epoch ||
    delivered.cursor < state.trimmed ||
    delivered.cursor > state.cursor
  ) {
    return { ...consumed, reset: true, chunk: state.buffer };
  }
  if (delivered.cursor === state.cursor) {
    return { ...consumed, chunk: "" };
  }
  return { ...consumed, chunk: state.buffer.slice(delivered.cursor - state.trimmed) };
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState {
  switch (event.type) {
    case "snapshot":
    case "restarted":
      return terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes, current.epoch + 1);
    case "output": {
      const trimmed = trimBufferToBytes(
        `${current.buffer}${event.data}`,
        current.bytes + utf8Length(event.data),
        maxBufferBytes,
      );
      return {
        ...current,
        buffer: trimmed.buffer,
        bytes: trimmed.bytes,
        cursor: current.cursor + event.data.length,
        trimmed: current.trimmed + trimmed.dropped,
        status: current.status === "closed" ? "running" : current.status,
        error: null,
        version: current.version + 1,
      };
    }
    case "cleared":
      return {
        ...current,
        buffer: "",
        bytes: 0,
        cursor: 0,
        trimmed: 0,
        epoch: current.epoch + 1,
        error: null,
        version: current.version + 1,
      };
    case "exited":
      return {
        ...current,
        status: "exited",
        error: null,
        version: current.version + 1,
      };
    case "closed":
      return {
        ...current,
        status: "closed",
        error: null,
        version: current.version + 1,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: event.message,
        version: current.version + 1,
      };
    case "activity":
      return current;
  }
}

export function applyTerminalMetadataStreamEvent(
  current: ReadonlyArray<TerminalSummary>,
  event: TerminalMetadataStreamEvent,
): ReadonlyArray<TerminalSummary> {
  if (event.type === "snapshot") {
    return event.terminals;
  }
  if (event.type === "remove") {
    return current.filter(
      (terminal) =>
        terminal.threadId !== event.threadId || terminal.terminalId !== event.terminalId,
    );
  }
  const next = current.filter(
    (terminal) =>
      terminal.threadId !== event.terminal.threadId ||
      terminal.terminalId !== event.terminal.terminalId,
  );
  return [...next, event.terminal];
}
