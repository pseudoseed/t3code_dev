import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, TerminalSessionSnapshot, ThreadId } from "@t3tools/contracts";

import {
  applyTerminalAttachStreamEvent,
  applyTerminalMetadataStreamEvent,
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  selectRunningSubprocessTerminalIds,
  terminalBufferDelta,
} from "./terminalSession.ts";

const TARGET = {
  environmentId: EnvironmentId.make("env-local"),
  threadId: ThreadId.make("thread-1"),
  terminalId: "term-1",
} as const;

const BASE_SNAPSHOT: TerminalSessionSnapshot = {
  threadId: TARGET.threadId,
  terminalId: TARGET.terminalId,
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 123,
  history: "hello",
  exitCode: null,
  exitSignal: null,
  label: "Terminal 1",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

describe("terminal session reducers", () => {
  it("prefers live attach status over stale metadata after the attach stream starts", () => {
    const summary = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: "running",
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    })[0]!;
    const attached = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "error",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      message: "Terminal disconnected.",
    });

    expect(combineTerminalSessionState(summary, attached)).toMatchObject({
      status: "error",
      error: "Terminal disconnected.",
      version: 1,
    });
  });

  it("uses metadata status before an attach stream has emitted", () => {
    const summary = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: "running",
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    })[0]!;

    expect(combineTerminalSessionState(summary, EMPTY_TERMINAL_BUFFER_STATE).status).toBe(
      "running",
    );
  });

  it("does not treat an idle running shell as a running subprocess", () => {
    const idleSession = {
      target: TARGET,
      state: {
        ...combineTerminalSessionState(null, EMPTY_TERMINAL_BUFFER_STATE),
        status: "running" as const,
        hasRunningSubprocess: false,
      },
    };
    const activeSession = {
      target: { ...TARGET, terminalId: "term-2" },
      state: {
        ...idleSession.state,
        hasRunningSubprocess: true,
      },
    };

    expect(selectRunningSubprocessTerminalIds([idleSession, activeSession])).toEqual(["term-2"]);
  });

  it("reduces attach snapshots and output without an imperative session manager", () => {
    const snapshot = applyTerminalAttachStreamEvent(EMPTY_TERMINAL_BUFFER_STATE, {
      type: "snapshot",
      snapshot: BASE_SNAPSHOT,
    });
    const output = applyTerminalAttachStreamEvent(
      snapshot,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: " world",
      },
      8,
    );

    // Trimming drops to a fraction of the cap so it runs once per many chunks
    // instead of shaving every chunk off the front.
    expect(output).toMatchObject({
      buffer: " world",
      status: "running",
      error: null,
      version: 2,
    });
    expect(output.buffer.length).toBe(output.cursor - output.trimmed);
  });

  it("reduces terminal metadata snapshots, upserts, and removals", () => {
    const initial = applyTerminalMetadataStreamEvent([], {
      type: "snapshot",
      terminals: [
        {
          threadId: BASE_SNAPSHOT.threadId,
          terminalId: BASE_SNAPSHOT.terminalId,
          cwd: BASE_SNAPSHOT.cwd,
          worktreePath: BASE_SNAPSHOT.worktreePath,
          status: BASE_SNAPSHOT.status,
          pid: BASE_SNAPSHOT.pid,
          exitCode: BASE_SNAPSHOT.exitCode,
          exitSignal: BASE_SNAPSHOT.exitSignal,
          updatedAt: BASE_SNAPSHOT.updatedAt,
          hasRunningSubprocess: false,
          label: BASE_SNAPSHOT.label,
        },
      ],
    });
    const updated = applyTerminalMetadataStreamEvent(initial, {
      type: "upsert",
      terminal: {
        ...initial[0]!,
        hasRunningSubprocess: true,
      },
    });
    const removed = applyTerminalMetadataStreamEvent(updated, {
      type: "remove",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]?.hasRunningSubprocess).toBe(true);
    expect(removed).toEqual([]);
  });

  it("caps retained output by UTF-8 byte length", () => {
    const state = applyTerminalAttachStreamEvent(
      EMPTY_TERMINAL_BUFFER_STATE,
      {
        type: "output",
        threadId: TARGET.threadId,
        terminalId: TARGET.terminalId,
        data: "🙂🙂",
      },
      4,
    );

    expect(state.buffer).toBe("🙂");
  });
});

describe("terminalBufferDelta", () => {
  const output = (state: typeof EMPTY_TERMINAL_BUFFER_STATE, data: string, cap?: number) =>
    applyTerminalAttachStreamEvent(
      state,
      { type: "output", threadId: TARGET.threadId, terminalId: TARGET.terminalId, data },
      cap,
    );

  it("hands a caught-up renderer only what arrived since it last wrote", () => {
    const first = output(EMPTY_TERMINAL_BUFFER_STATE, "hello");
    const second = output(first, " world");

    expect(terminalBufferDelta(second, first)).toMatchObject({
      reset: false,
      chunk: " world",
      cursor: second.cursor,
    });
  });

  it("hands a renderer at the head nothing", () => {
    const state = output(EMPTY_TERMINAL_BUFFER_STATE, "hello");

    expect(terminalBufferDelta(state, state)).toMatchObject({ reset: false, chunk: "" });
  });

  it("keeps appending after trimming drops the front of the buffer", () => {
    // Trimming used to break the prefix comparison both renderers relied on, so
    // every later chunk replayed the whole buffer into a fresh surface.
    let state = output(EMPTY_TERMINAL_BUFFER_STATE, "0123456789", 8);
    expect(state.trimmed).toBeGreaterThan(0);

    const caughtUp = state;
    state = output(state, "abc", 8);

    expect(terminalBufferDelta(state, caughtUp)).toMatchObject({ reset: false, chunk: "abc" });
  });

  it("resets a renderer that fell behind the trim point", () => {
    const stale = output(EMPTY_TERMINAL_BUFFER_STATE, "0123", 8);
    const state = output(output(stale, "456789", 8), "abcdef", 8);

    expect(terminalBufferDelta(state, stale)).toMatchObject({
      reset: true,
      chunk: state.buffer,
    });
  });

  it("resets a renderer across a clear", () => {
    const before = output(EMPTY_TERMINAL_BUFFER_STATE, "hello");
    const cleared = applyTerminalAttachStreamEvent(before, {
      type: "cleared",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
    });

    expect(cleared.epoch).not.toBe(before.epoch);
    expect(terminalBufferDelta(cleared, before)).toMatchObject({ reset: true, chunk: "" });
  });

  it("resets a renderer that has written nothing yet", () => {
    const state = output(EMPTY_TERMINAL_BUFFER_STATE, "hello");

    expect(terminalBufferDelta(state, null)).toMatchObject({ reset: true, chunk: "hello" });
  });
});
