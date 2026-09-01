import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SourceControlProviderKind } from "@t3tools/contracts";

import * as ForgejoIssueProvider from "./ForgejoIssueProvider.ts";
import * as GitHubIssueProvider from "./GitHubIssueProvider.ts";
import type { IssueProviderApi } from "./IssueProvider.ts";

export class IssueProviderRegistry extends Context.Service<
  IssueProviderRegistry,
  {
    /** Null for a host with no implementation, which the panel reports as unsupported. */
    readonly get: (kind: SourceControlProviderKind) => IssueProviderApi | null;
    readonly kinds: ReadonlyArray<SourceControlProviderKind>;
  }
>()("t3/issue/IssueProviderRegistry") {}

/** Exported for tests, which stand a registry up from providers they supply themselves. */
export function fromProviders(
  providers: ReadonlyArray<IssueProviderApi>,
): IssueProviderRegistry["Service"] {
  const byKind = new Map(providers.map((provider) => [provider.kind, provider]));
  return {
    get: (kind) => byKind.get(kind) ?? null,
    kinds: providers.map((provider) => provider.kind),
  };
}

/**
 * The hosts this build can read issues from. A host with no entry here is reported as
 * unsupported, so its projects are explained rather than silently empty.
 */
export const make = Effect.map(
  Effect.all([GitHubIssueProvider.make, ForgejoIssueProvider.make]),
  fromProviders,
);

export const layer = Layer.effect(IssueProviderRegistry, make);
