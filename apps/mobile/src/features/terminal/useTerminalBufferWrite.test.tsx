import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  applyTerminalAttachStreamEvent,
  EMPTY_TERMINAL_BUFFER_STATE,
  type TerminalOutputState,
} from "@t3tools/client-runtime/state/terminal";
import { useTerminalBufferWrite } from "./useTerminalBufferWrite";

afterEach(() => vi.unstubAllGlobals());

it("delivers rapid output in frame batches without losing bytes or replaying on chat renders", async () => {
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const received: string[] = [];
  function Surface({ output }: { output: TerminalOutputState }) {
    const write = useTerminalBufferWrite(output);
    useLayoutEffect(() => {
      if (write.seq > 0) received.push(write.data);
    }, [write]);
    return null;
  }
  let state = EMPTY_TERMINAL_BUFFER_STATE;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Surface output={state.output} />);
  });
  try {
    const expected: string[] = [];
    for (let frame = 0; frame < 4; frame++) {
      for (let index = 0; index < 80; index++) {
        const data = `${frame}:${index}\n`;
        expected.push(data);
        state = applyTerminalAttachStreamEvent(state, {
          type: "output",
          threadId: "thread",
          terminalId: "term-1",
          data,
        });
        await act(async () => {
          renderer.update(<Surface output={state.output} />);
        });
      }
      expect(frames.size).toBe(1);
      await act(async () => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(0));
      });
      expect(received).toHaveLength(frame + 1);
    }
    expect(received.join("")).toBe(expected.join(""));
    await act(async () => {
      renderer.update(<Surface output={state.output} />);
    });
    expect(frames.size).toBe(0);
    expect(received).toHaveLength(4);
    state = applyTerminalAttachStreamEvent(state, {
      type: "output",
      threadId: "thread",
      terminalId: "term-1",
      data: "unmount",
    });
    await act(async () => {
      renderer.update(<Surface output={state.output} />);
    });
  } finally {
    await act(async () => renderer.unmount());
  }
  expect(frames.size).toBe(0);
});
