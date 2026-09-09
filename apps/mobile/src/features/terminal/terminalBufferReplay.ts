import type { TerminalOutputState } from "@t3tools/client-runtime/state/terminal";
import { EMPTY_TERMINAL_OUTPUT_STATE } from "@t3tools/client-runtime/state/terminal";

import { terminalDebugLog } from "./terminalDebugLog";

export const TERMINAL_BUFFER_REPLAY_STABILITY_DELAY_MS = 180;

/**
 * What the native surface should be showing. Renderers read the slice between
 * their own cursor and this output, so the output state has to travel with the
 * text it describes.
 */
export interface TerminalSurfaceContent {
  readonly output: TerminalOutputState;
}

/**
 * Generation no live session can hold. A surface parked here is guaranteed a
 * full replay once a real generation returns, however far the session moved
 * meanwhile.
 */
const HIDDEN_GENERATION = -1;

const HIDDEN_CONTENT: TerminalSurfaceContent = {
  output: { ...EMPTY_TERMINAL_OUTPUT_STATE, generation: HIDDEN_GENERATION },
};

export function getTerminalBufferReplayKey(input: {
  readonly terminalKey: string;
  readonly fontSize: number;
}): string {
  return `${input.terminalKey}:${input.fontSize}`;
}

export function getTerminalSurfaceReplayContent(input: {
  readonly terminal: { readonly output: TerminalOutputState };
  readonly replayKey: string;
  readonly readyReplayKey: string | null;
}): TerminalSurfaceContent {
  // Pass live content whenever ready key is unset or matches. Only hide when the
  // ready key is stale vs the current replay key (e.g. mid font-size transition).
  if (input.readyReplayKey !== null && input.readyReplayKey !== input.replayKey) {
    terminalDebugLog("replay:stale-key-hiding-buffer", {
      replayKey: input.replayKey,
      readyReplayKey: input.readyReplayKey,
      retainedBytes: input.terminal.output.retainedBytes,
    });
    return HIDDEN_CONTENT;
  }

  return { output: input.terminal.output };
}
