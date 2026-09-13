import {
  ClientPresentation,
  CloudSession,
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
  PrimaryEnvironmentAuth,
  RelayDeviceIdentity,
  SshEnvironmentGateway,
} from "@t3tools/client-runtime/platform";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  Connectivity,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { managedRelayAccountChanges, managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import Constants from "expo-constants";
import * as Network from "expo-network";
import { AppState } from "react-native";

import { authClientMetadata } from "../lib/authClientMetadata";
import * as Runtime from "../lib/runtime";
import * as MobileStorage from "../persistence/mobile-storage";
import { appAtomRegistry } from "../state/atom-registry";
import { clearThreadOutboxEnvironment } from "../state/thread-outbox-removal";
import { clearComposerDraftsEnvironment } from "../state/use-composer-drafts";
import { mobileApplicationActiveWakeup } from "./app-state-wakeups";
import { recordConnectionDiagnostic } from "./diagnostics";
import { connectionStorageLayer } from "./storage";

/**
 * iOS reports a path change several times around a wake, and a resume-time
 * query can briefly answer "no path" while the socket underneath is fine. The
 * supervisor no longer acts on "offline", but it does probe on "online", so
 * a flap is settled here before it can trigger a probe per bounce.
 */
const NETWORK_CHANGE_DEBOUNCE = "1 second";

function networkStatus(state: Network.NetworkState): "unknown" | "offline" | "online" {
  if (state.isConnected === false) {
    return "offline";
  }
  if (state.isConnected === true) {
    return "online";
  }
  return "unknown";
}

type MobileNetworkStatus = ReturnType<typeof networkStatus>;

const queryNetworkStatus = Effect.tryPromise({
  try: () => Network.getNetworkStateAsync(),
  catch: () => undefined,
}).pipe(
  Effect.match({
    onFailure: () => "unknown" as const,
    onSuccess: networkStatus,
  }),
);

// One native listener feeds every environment supervisor. Each supervisor
// used to install its own listener and its own resume-time path query, which
// on iOS spins up a fresh path monitor per call on the busiest frame of the
// resume.
const connectivityLayer = Layer.effect(
  Connectivity.Connectivity,
  Effect.gen(function* () {
    const updates = yield* PubSub.unbounded<MobileNetworkStatus>();
    let latest: MobileNetworkStatus | null = null;
    const publish = (state: Network.NetworkState, source: string) => {
      const status = networkStatus(state);
      recordConnectionDiagnostic("network", `${status} type=${state.type ?? "?"} (${source})`);
      latest = status;
      PubSub.publishUnsafe(updates, status);
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        let active = true;
        const networkSubscription = Network.addNetworkStateListener((state) => {
          if (active) publish(state, "listener");
        });
        const appStateSubscription = AppState.addEventListener("change", (state) => {
          if (state !== "active") {
            return;
          }
          void Network.getNetworkStateAsync()
            .then((current) => {
              if (active) publish(current, "resume");
            })
            .catch(() => undefined);
        });
        return () => {
          active = false;
          networkSubscription.remove();
          appStateSubscription.remove();
        };
      }),
      (close) => Effect.sync(close),
    );
    return Connectivity.Connectivity.of({
      status: Effect.suspend(() => (latest === null ? queryNetworkStatus : Effect.succeed(latest))),
      changes: Stream.fromPubSub(updates).pipe(Stream.debounce(NETWORK_CHANGE_DEBOUNCE)),
    });
  }),
);

const wakeupsLayer = Layer.effect(
  Wakeups.ConnectionWakeups,
  Effect.gen(function* () {
    const wakeups = yield* PubSub.unbounded<
      "application-active-probe" | "application-active-reconnect"
    >();
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        let backgroundedAtMs = AppState.currentState === "background" ? Date.now() : null;
        return AppState.addEventListener("change", (state) => {
          recordConnectionDiagnostic("app-state", state);
          if (state === "background") {
            backgroundedAtMs = Date.now();
            return;
          }
          if (state === "active") {
            const wakeup = mobileApplicationActiveWakeup(backgroundedAtMs, Date.now());
            recordConnectionDiagnostic(
              "wakeup",
              backgroundedAtMs === null
                ? wakeup
                : `${wakeup} after ${Math.round((Date.now() - backgroundedAtMs) / 1000)}s`,
            );
            backgroundedAtMs = null;
            PubSub.publishUnsafe(wakeups, wakeup);
          }
        });
      }),
      (subscription) => Effect.sync(() => subscription.remove()),
    );
    return Wakeups.ConnectionWakeups.of({
      changes: Stream.merge(
        Stream.fromPubSub(wakeups),
        managedRelayAccountChanges(appAtomRegistry).pipe(
          Stream.map(() => "credentials-changed" as const),
        ),
      ),
    });
  }),
);

const capabilitiesLayer = Layer.effectContext(
  Effect.gen(function* () {
    const storage = yield* MobileStorage.MobileStorage;
    return Context.make(
      CloudSession,
      CloudSession.of({
        identity: Effect.sync(() =>
          Option.fromNullishOr(appAtomRegistry.get(managedRelaySessionAtom)),
        ),
        clerkToken: Effect.gen(function* () {
          const session = appAtomRegistry.get(managedRelaySessionAtom);
          if (session === null) {
            return yield* new ConnectionBlockedError({
              reason: "authentication",
              detail: "Sign in to Cloud Connect to connect this environment.",
            });
          }
          const token = yield* session.readClerkToken().pipe(
            Effect.mapError(
              (error) =>
                new ConnectionTransientError({
                  reason: "network",
                  detail: error.message,
                }),
            ),
          );
          if (token === null) {
            return yield* new ConnectionBlockedError({
              reason: "authentication",
              detail: "The Cloud Connect session is unavailable.",
            });
          }
          return token;
        }),
      }),
    ).pipe(
      Context.add(
        PrimaryEnvironmentAuth,
        PrimaryEnvironmentAuth.of({ bearerToken: Effect.succeed(Option.none()) }),
      ),
      Context.add(
        RelayDeviceIdentity,
        RelayDeviceIdentity.of({
          deviceId: storage.loadOrCreateAgentAwarenessDeviceId.pipe(
            Effect.mapError(
              (cause) =>
                new ConnectionTransientError({
                  reason: "remote-unavailable",
                  detail: `Could not load the mobile device identity: ${String(cause)}`,
                }),
            ),
            Effect.map(Option.some),
          ),
        }),
      ),
      Context.add(
        ClientPresentation,
        ClientPresentation.of({
          metadata: authClientMetadata(Constants.expoConfig?.version),
          scopes: AuthStandardClientScopes,
        }),
      ),
      Context.add(
        SshEnvironmentGateway,
        SshEnvironmentGateway.of({
          provision: () =>
            Effect.fail(
              new ConnectionBlockedError({
                reason: "unsupported",
                detail: "SSH environments are only available in the desktop app.",
              }),
            ),
          prepare: () =>
            Effect.fail(
              new ConnectionBlockedError({
                reason: "unsupported",
                detail: "SSH environments are only available in the desktop app.",
              }),
            ),
          disconnect: () => Effect.void,
        }),
      ),
    );
  }),
);

const platformConnectionSourceLayer = Layer.succeed(
  PlatformConnectionSource,
  PlatformConnectionSource.of({
    registrations: Stream.empty,
  }),
);

const providedConnectionStorageLayer = connectionStorageLayer.pipe(
  Layer.provide(Runtime.runtimeContextLayer),
);
const providedCapabilitiesLayer = capabilitiesLayer.pipe(
  Layer.provide(Runtime.runtimeContextLayer),
);

const environmentOwnedDataCleanupLayer = Layer.succeed(
  EnvironmentOwnedDataCleanup,
  EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Effect.all(
        [
          Effect.promise(() => clearThreadOutboxEnvironment(environmentId)),
          Effect.promise(() => clearComposerDraftsEnvironment(environmentId)),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not clear mobile environment-owned data.", {
            environmentId,
            cause,
          }),
        ),
      ),
  }),
);

type ConnectionPlatformLayerSource =
  | typeof providedConnectionStorageLayer
  | typeof Runtime.runtimeContextLayer
  | typeof connectivityLayer
  | typeof wakeupsLayer
  | typeof providedCapabilitiesLayer
  | typeof platformConnectionSourceLayer
  | typeof environmentOwnedDataCleanupLayer;

export const connectionPlatformLayer: Layer.Layer<
  Layer.Success<ConnectionPlatformLayerSource>,
  Layer.Error<ConnectionPlatformLayerSource>,
  Layer.Services<ConnectionPlatformLayerSource>
> = Layer.mergeAll(
  providedConnectionStorageLayer,
  Runtime.runtimeContextLayer,
  connectivityLayer,
  wakeupsLayer,
  providedCapabilitiesLayer,
  platformConnectionSourceLayer,
  environmentOwnedDataCleanupLayer,
);
