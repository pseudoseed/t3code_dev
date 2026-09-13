import { Connection, EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { shellSnapshotLoaderLayer } from "@t3tools/client-runtime/state/shell";
import { threadSnapshotLoaderLayer } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import type { FoundationHotModule } from "../lib/foundation-fast-refresh";
import { hotSwappableAtomRuntime } from "../lib/hot-swappable-atom-runtime";
import { runtimeContextLayer } from "../lib/runtime";
import { appAtomRegistry } from "../state/atom-registry";
import {
  mobileBackgroundActivityObserverLayer,
  mobileBackgroundActivityReporterLayer,
} from "./background-activity";
import { recordConnectionDiagnostic } from "./diagnostics";
import { connectionPlatformLayer } from "./platform";

/** Mirrors every supervisor phase change into the device connection log. */
const connectionDiagnosticsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    const tracked = new Set<EnvironmentId>();
    yield* Stream.concat(
      Stream.fromEffect(SubscriptionRef.get(registry.entries)),
      SubscriptionRef.changes(registry.entries),
    ).pipe(
      Stream.runForEach((entries) =>
        Effect.forEach(
          [...entries].filter(([environmentId]) => !tracked.has(environmentId)),
          ([environmentId, entry]) => {
            tracked.add(environmentId);
            return registry.stateChanges(environmentId).pipe(
              Stream.runForEach((state) =>
                Effect.sync(() =>
                  recordConnectionDiagnostic(
                    "connection",
                    `${entry.target.label}: ${state.phase}${state.stage ? `/${state.stage}` : ""} attempt=${state.attempt} gen=${state.generation} net=${state.network}${
                      state.lastFailure ? ` failure=${state.lastFailure.detail}` : ""
                    }`,
                  ),
                ),
              ),
              Effect.ignore,
              Effect.forkScoped,
            );
          },
          { discard: true },
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

declare const module: { readonly hot?: FoundationHotModule } | undefined;

const providedConnectionPlatformLayer = connectionPlatformLayer.pipe(
  Layer.provide(runtimeContextLayer),
);

const snapshotLoaderLayer = Layer.merge(threadSnapshotLoaderLayer, shellSnapshotLoaderLayer);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof snapshotLoaderLayer
  | typeof runtimeContextLayer
  | typeof connectionPlatformLayer
  | typeof mobileBackgroundActivityObserverLayer
  | typeof mobileBackgroundActivityReporterLayer;

const providedClientConnectionLayer = snapshotLoaderLayer.pipe(
  Layer.provideMerge(
    Connection.layerWithOptions({ usageLimitSources: true, usageLimitsCommand: true }),
  ),
  Layer.provideMerge(
    Layer.mergeAll(
      runtimeContextLayer,
      providedConnectionPlatformLayer,
      mobileBackgroundActivityObserverLayer,
    ),
  ),
);

const connectionLayer = Layer.merge(
  mobileBackgroundActivityReporterLayer,
  connectionDiagnosticsLayer,
).pipe(Layer.provideMerge(providedClientConnectionLayer));

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = hotSwappableAtomRuntime({
  id: "t3.mobile.connection-runtime",
  hotModule: typeof module === "undefined" ? undefined : module.hot,
  registry: appAtomRegistry,
  layer: connectionLayer,
});
