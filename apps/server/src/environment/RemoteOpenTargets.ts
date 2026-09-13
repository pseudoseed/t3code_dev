/**
 * RemoteOpenTargets - resolves the SSH hostnames this environment advertises
 * for remote open-in-editor deep links (`vscode://vscode-remote/ssh-remote+…`).
 *
 * The server can only check itself: sshd listening locally, tailscaled
 * reporting a MagicDNS name, and the machine hostname for mDNS. Whether a
 * given name resolves from the viewer's machine is inherently client-side.
 * Targets are ordered most-reachable first (tailnet name works from anywhere
 * on the tailnet; `<hostname>.local` only on the same LAN).
 */
import { type RemoteOpenTarget } from "@t3tools/contracts";
import { HostProcessHostname } from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import { readTailscaleStatus } from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const SSH_PORT = 22;
/**
 * Resolution spawns `tailscale status` and probes sshd, each under a 5 s
 * budget, and it sits on the critical path of every client's first config
 * frame. Targets change on the order of minutes (tailscaled up or down, a
 * hostname edit), so a reconnecting client gets the last answer at once and
 * the refresh runs behind it.
 */
export const REMOTE_OPEN_TARGETS_TTL_MS = 60_000;

export class RemoteOpenTargets extends Context.Service<
  RemoteOpenTargets,
  {
    readonly resolveTargets: () => Effect.Effect<ReadonlyArray<RemoteOpenTarget>>;
  }
>()("t3/environment/RemoteOpenTargets") {}

/** @public Service construction is part of the canonical Effect module API. */
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
    if (!sshdListening) {
      return [];
    }

    const targets: Array<RemoteOpenTarget> = [];

    // Tailscale absent or down is the common case, not an error.
    const magicDnsName = yield* readTailscaleStatus.pipe(
      Effect.map((status) => status.magicDnsName),
      Effect.orElseSucceed(() => null),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    if (magicDnsName !== null) {
      targets.push({ kind: "tailscale", host: magicDnsName });
    }

    // os.hostname() may already be an FQDN (macOS often reports
    // "Name.local"); mDNS names are always `<first-label>.local`.
    const hostname = yield* HostProcessHostname;
    const shortHostname = hostname.split(".")[0]?.trim();
    if (shortHostname !== undefined && shortHostname.length > 0) {
      targets.push({ kind: "mdns", host: `${shortHostname}.local` });
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

  return RemoteOpenTargets.of({ resolveTargets: () => resolveTargets });
});

export const layer = Layer.effect(RemoteOpenTargets, make);
