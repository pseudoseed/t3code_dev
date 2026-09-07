import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/** Only an open inbox fetches bodies. Shell counts and revisions drive visibility and refresh. */
export function createMailboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const detail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:mailbox",
    tag: WS_METHODS.mailboxGet,
    staleTimeMs: 0,
  });
  const update = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:mailbox:update",
    tag: WS_METHODS.mailboxUpdate,
    scheduler: createAtomCommandScheduler(),
    concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    onSuccess: ({ environmentId, input }, registry) =>
      Effect.sync(() =>
        registry.refresh(detail({ environmentId, input: { threadId: input.threadId } })),
      ),
  });
  return { detail, update };
}
