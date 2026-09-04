import type { TerminalSessionState } from "@t3tools/client-runtime/state/terminal";

import { terminalDebugLog } from "./terminalDebugLog";

export const TERMINAL_BUFFER_REPLAY_STABILITY_DELAY_MS = 180;

/**
 * What the native surface should be showing. Renderers write the slice between
 * their own cursor and this one, so the cursor fields have to travel with the
 * buffer they describe.
 */
export interface TerminalSurfaceContent {
  readonly buffer: string;
  readonly cursor: number;
  readonly trimmed: number;
  readonly epoch: number;
}

/**
 * Epoch no live session can hold. A surface parked here is guaranteed a full
 * replay once the real epoch returns, however far the session moved meanwhile.
 */
const HIDDEN_EPOCH = -1;

const HIDDEN_CONTENT: TerminalSurfaceContent = {
  buffer: "",
  cursor: 0,
  trimmed: 0,
  epoch: HIDDEN_EPOCH,
};

export function getTerminalBufferReplayKey(input: {
  readonly terminalKey: string;
  readonly fontSize: number;
}): string {
  return `${input.terminalKey}:${input.fontSize}`;
}

export function getTerminalSurfaceReplayContent(input: {
  readonly terminal: Pick<TerminalSessionState, "buffer" | "cursor" | "trimmed" | "epoch">;
  readonly replayKey: string;
  readonly readyReplayKey: string | null;
}): TerminalSurfaceContent {
  // Pass live content whenever ready key is unset or matches. Only hide when the
  // ready key is stale vs the current replay key (e.g. mid font-size transition).
  if (input.readyReplayKey !== null && input.readyReplayKey !== input.replayKey) {
    terminalDebugLog("replay:stale-key-hiding-buffer", {
      replayKey: input.replayKey,
      readyReplayKey: input.readyReplayKey,
      bufferLen: input.terminal.buffer.length,
    });
    return HIDDEN_CONTENT;
  }

  return {
    buffer: input.terminal.buffer,
    cursor: input.terminal.cursor,
    trimmed: input.terminal.trimmed,
    epoch: input.terminal.epoch,
  };
}
