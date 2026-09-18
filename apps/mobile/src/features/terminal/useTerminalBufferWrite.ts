import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  type TerminalOutputState,
} from "@t3tools/client-runtime/state/terminal";
import { IDLE_TERMINAL_BUFFER_WRITE, mergeTerminalBufferWrite } from "./terminalBufferWrite";

/** Coalesce output into one native update per frame; never cascade an effect update per byte. */
export function useTerminalBufferWrite(output: TerminalOutputState) {
  const [write, setWrite] = useState(IDLE_TERMINAL_BUFFER_WRITE);
  const cursor = useRef(INITIAL_TERMINAL_OUTPUT_CURSOR);
  const committedSeq = useRef(0);
  const pendingOutput = useRef(output);
  const frame = useRef<number | null>(null);
  useLayoutEffect(() => {
    committedSeq.current = write.seq;
  }, [write]);
  useEffect(() => {
    pendingOutput.current = output;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const update = readTerminalOutputUpdate(pendingOutput.current, cursor.current);
      cursor.current = update.cursor;
      if (update.type === "none") return;
      const seq = committedSeq.current;
      setWrite((pending) => mergeTerminalBufferWrite({ pending, committedSeq: seq, update }));
    });
  }, [output]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    },
    [],
  );
  return write;
}
