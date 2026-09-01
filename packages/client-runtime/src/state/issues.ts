import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Issues for the project the panel is following.
 *
 * Every read costs a request to the host, so answers are reused for a short while and refreshed
 * when the reader asks. Writes run serially per environment and refresh what they changed: a
 * comment and a state change both alter the issue that is on screen, and a new issue alters the
 * list behind it.
 */
export function createIssueEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const serialPerEnvironment = {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  } as const;

  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:list",
    tag: WS_METHODS.issuesList,
    staleTimeMs: 30_000,
  });
  const detail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:issues:detail",
    tag: WS_METHODS.issuesDetail,
    staleTimeMs: 15_000,
  });

  return {
    list,
    detail,
    comment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:comment",
      tag: WS_METHODS.issuesComment,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: ({ environmentId, input: { projectId, repository, number } }, registry) =>
        Effect.sync(() =>
          registry.refresh(detail({ environmentId, input: { projectId, repository, number } })),
        ),
    }),
    setState: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:set-state",
      tag: WS_METHODS.issuesSetState,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
      onSuccess: ({ environmentId, input: { projectId, repository, number } }, registry) =>
        Effect.sync(() =>
          registry.refresh(detail({ environmentId, input: { projectId, repository, number } })),
        ),
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:issues:create",
      tag: WS_METHODS.issuesCreate,
      scheduler: commandScheduler,
      concurrency: serialPerEnvironment,
    }),
  };
}
