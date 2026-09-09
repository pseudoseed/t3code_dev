import { describe, expect, it } from "vite-plus/test";
import {
  EMPTY_TERMINAL_OUTPUT_STATE,
  terminalOutputText,
} from "@t3tools/client-runtime/state/terminal";

import {
  getTerminalBufferReplayKey,
  getTerminalSurfaceReplayContent,
} from "./terminalBufferReplay";

const TERMINAL = {
  output: {
    ...EMPTY_TERMINAL_OUTPUT_STATE,
    generation: 1,
    chunks: [{ startOffset: 0, data: "fastfetch output", byteLength: 16 }],
    retainedBytes: 16,
    nextOffset: 16,
  },
};

describe("terminalBufferReplay", () => {
  it("keys replay readiness by terminal identity and font metrics", () => {
    expect(
      getTerminalBufferReplayKey({
        terminalKey: "env-1:thread-1:default",
        fontSize: 10,
      }),
    ).toBe("env-1:thread-1:default:10");
  });

  it("shows terminal history while replay key is unset (initial mount / after key change)", () => {
    const replayKey = getTerminalBufferReplayKey({
      terminalKey: "env-1:thread-1:default",
      fontSize: 10,
    });

    expect(
      getTerminalSurfaceReplayContent({
        terminal: TERMINAL,
        replayKey,
        readyReplayKey: null,
      }),
    ).toEqual(TERMINAL);
    expect(
      getTerminalSurfaceReplayContent({
        terminal: TERMINAL,
        replayKey,
        readyReplayKey: replayKey,
      }),
    ).toEqual(TERMINAL);
  });

  it("hides content behind an unreachable generation while the replay key is stale", () => {
    const replayKey = getTerminalBufferReplayKey({
      terminalKey: "env-1:thread-1:default",
      fontSize: 10,
    });
    const hidden = getTerminalSurfaceReplayContent({
      terminal: TERMINAL,
      replayKey,
      readyReplayKey: "env-1:thread-1:default:11",
    });

    expect(terminalOutputText(hidden.output)).toBe("");
    // A surface parked on the hidden generation must replay in full once it clears.
    expect(hidden.output.generation).not.toBe(TERMINAL.output.generation);
  });
});
