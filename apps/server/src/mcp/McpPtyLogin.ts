import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { CliInvocation } from "../provider/CliLoginAuth.ts";
import { PtyAdapter } from "../terminal/PtyAdapter.ts";

/** Claude's headless MCP flow still requires a TTY to accept a pasted redirect. */
export const runMcpPtyLogin = Effect.fn("runMcpPtyLogin")(function* (
  invocation: CliInvocation,
  input: Queue.Queue<string, Cause.Done>,
  onLine: (line: string) => Effect.Effect<void>,
) {
  const adapter = yield* PtyAdapter;
  const events = yield* Queue.unbounded<
    { type: "data"; data: string } | { type: "exit"; code: number }
  >();
  let exited = false;
  const child = yield* Effect.acquireRelease(
    adapter.spawn({
      shell: invocation.command,
      args: [...invocation.args],
      cwd: invocation.cwd ?? process.cwd(),
      env: invocation.env,
      cols: 240,
      rows: 24,
    }),
    (child) =>
      Effect.sync(() => {
        if (!exited) child.kill();
      }),
  ).pipe(Effect.option);
  if (child._tag === "None") return { exitCode: null, output: "" };
  const childProcess = child.value;
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const data = childProcess.onData((data) => Queue.offerUnsafe(events, { type: "data", data }));
      const exit = childProcess.onExit(({ exitCode }) => {
        exited = true;
        Queue.offerUnsafe(events, { type: "exit", code: exitCode });
      });
      return () => {
        data();
        exit();
      };
    }),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
  yield* Stream.fromQueue(input).pipe(
    Stream.runForEach((value) => Effect.sync(() => childProcess.write(value.replace(/\n$/, "\r")))),
    Effect.forkScoped,
  );
  let output = "";
  let pending = "";
  while (true) {
    const event = yield* Queue.take(events);
    if (event.type === "exit") {
      if (pending) yield* onLine(pending);
      return { exitCode: event.code, output };
    }
    output = `${output}${event.data}`.slice(-8_000);
    pending = `${pending}${event.data}`;
    const lines = pending.split(/\r?\n/);
    pending = (lines.pop() ?? "").slice(-16_384);
    for (const line of lines) yield* onLine(line);
  }
});
