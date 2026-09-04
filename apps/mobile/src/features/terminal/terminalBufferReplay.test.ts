import { describe, expect, it } from "vite-plus/test";

import {
  getTerminalBufferReplayKey,
  getTerminalSurfaceReplayContent,
} from "./terminalBufferReplay";

const TERMINAL = {
  buffer: "fastfetch output",
  cursor: 16,
  trimmed: 0,
  epoch: 1,
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

  it("hides content behind an unreachable epoch while the replay key is stale", () => {
    const replayKey = getTerminalBufferReplayKey({
      terminalKey: "env-1:thread-1:default",
      fontSize: 10,
    });
    const hidden = getTerminalSurfaceReplayContent({
      terminal: TERMINAL,
      replayKey,
      readyReplayKey: "env-1:thread-1:default:11",
    });

    expect(hidden.buffer).toBe("");
    // A surface parked on the hidden epoch must replay in full once it clears.
    expect(hidden.epoch).not.toBe(TERMINAL.epoch);
  });
});
