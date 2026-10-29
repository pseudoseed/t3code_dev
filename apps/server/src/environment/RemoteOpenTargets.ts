import { type RemoteOpenTarget } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { readTailscaleSshEnabled, readTailscaleStatus } from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const SSH_PORT = 22;
/**
 * Resolution probes Tailscale and sshd (5 s each) on every client's first config frame, while
 * targets change over minutes, so reconnecting clients get the last answer while it refreshes.
 */
export const REMOTE_OPEN_TARGETS_TTL_MS = 60_000;

export class RemoteOpenTargets extends Context.Service<
  RemoteOpenTargets,
  {
    readonly resolveTargets: () => Effect.Effect<ReadonlyArray<RemoteOpenTarget>>;
  }
>()("t3/environment/RemoteOpenTargets") {}

/** @public */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;
  const scope = yield* Effect.scope;
  const cached = yield* Ref.make(
    Option.none<{
      readonly targets: ReadonlyArray<RemoteOpenTarget>;
      readonly resolvedAt: number;
    }>(),
  );
  const refreshing = yield* Ref.make(false);

  const resolveTargetsUncached = Effect.gen(function* () {
    // No local sshd means no name can work; advertise nothing so clients
    // render a clear "no SSH route" state instead of links that hang.
    // Check both loopback families: sshd can be bound IPv6-only.
    const sshdListening = yield* Effect.zipWith(
      net.hasListenerOnHost(SSH_PORT, "127.0.0.1"),
      net.hasListenerOnHost(SSH_PORT, "::1"),
      (ipv4, ipv6) => ipv4 || ipv6,
    );
    const username = yield* HostProcess.Username;

    const magicDnsName = yield* readTailscaleStatus.pipe(
      Effect.map((status) => status.magicDnsName),
      Effect.orElseSucceed(() => null),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const targets: Array<RemoteOpenTarget> = [];

    if (!sshdListening) {
      // Tailscale SSH needs no local sshd; tailscaled alone does not prove an SSH route.
      if (
        magicDnsName !== null &&
        (yield* readTailscaleSshEnabled.pipe(
          Effect.orElseSucceed(() => false),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ))
      ) {
        targets.push({
          kind: "tailscale",
          host: magicDnsName,
          ...(username === null ? {} : { username }),
        });
      }
      return targets;
    }

    if (magicDnsName !== null) {
      targets.push({
        kind: "tailscale",
        host: magicDnsName,
        ...(username === null ? {} : { username }),
      });
    }

    // hostname() may be an FQDN; mDNS always uses <first-label>.local.
    const hostname = yield* HostProcess.Hostname;
    const shortHostname = hostname.split(".")[0]?.trim();
    if (shortHostname !== undefined && shortHostname.length > 0) {
      targets.push({
        kind: "mdns",
        host: `${shortHostname}.local`,
        ...(username === null ? {} : { username }),
      });
    }

    return targets;
  });

  const refresh = Effect.gen(function* () {
    const targets = yield* resolveTargetsUncached;
    const resolvedAt = yield* Clock.currentTimeMillis;
    yield* Ref.set(cached, Option.some({ targets, resolvedAt }));
    return targets;
  });

  // Stale-while-revalidate: only the very first call waits on discovery.
  const resolveTargets = Effect.gen(function* () {
    const current = yield* Ref.get(cached);
    if (Option.isNone(current)) {
      return yield* refresh;
    }
    const now = yield* Clock.currentTimeMillis;
    if (now - current.value.resolvedAt >= REMOTE_OPEN_TARGETS_TTL_MS) {
      const alreadyRefreshing = yield* Ref.getAndSet(refreshing, true);
      if (!alreadyRefreshing) {
        yield* refresh.pipe(Effect.ensuring(Ref.set(refreshing, false)), Effect.forkIn(scope));
      }
    }
    return current.value.targets;
  });

  return RemoteOpenTargets.of({
    resolveTargets: Effect.fn("RemoteOpenTargets.resolveTargets")(function () {
      return resolveTargets;
    }),
  });
});

export const layer = Layer.effect(RemoteOpenTargets, make);
