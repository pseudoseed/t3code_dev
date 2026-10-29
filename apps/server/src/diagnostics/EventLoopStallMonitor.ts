import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface EventLoopStallMonitorOptions {
  readonly intervalMs: number;
  readonly thresholdMs: number;
  readonly report: (stall: { readonly stalledMs: number }) => Effect.Effect<void>;
}

const DEFAULT_STALL_INTERVAL_MS = 1_000;
const DEFAULT_STALL_THRESHOLD_MS = 5_000;

/** How late a timer fired: elapsed wall-clock time beyond the interval it asked for. */
export function stalledMillis(input: {
  readonly beforeMs: number;
  readonly afterMs: number;
  readonly intervalMs: number;
}): number {
  return Math.max(0, input.afterMs - input.beforeMs - input.intervalMs);
}

const run = Effect.fnUntraced(function* (options: EventLoopStallMonitorOptions) {
  for (;;) {
    const beforeMs = yield* Clock.currentTimeMillis;
    yield* Effect.sleep(Duration.millis(options.intervalMs));
    const afterMs = yield* Clock.currentTimeMillis;
    const stalledMs = stalledMillis({ beforeMs, afterMs, intervalMs: options.intervalMs });
    if (stalledMs >= options.thresholdMs) {
      yield* options.report({ stalledMs });
    }
  }
});

const reportStall = (stall: { readonly stalledMs: number }) =>
  Effect.logWarning("Event loop stalled; the host stopped scheduling the server.", {
    stalledMs: stall.stalledMs,
  }).pipe(
    Effect.withSpan("server.eventLoop.stall", {
      attributes: { "stall.duration_ms": stall.stalledMs },
    }),
  );

export const layer = Layer.effectDiscard(
  run({
    intervalMs: DEFAULT_STALL_INTERVAL_MS,
    thresholdMs: DEFAULT_STALL_THRESHOLD_MS,
    report: reportStall,
  }).pipe(Effect.forkScoped),
);
