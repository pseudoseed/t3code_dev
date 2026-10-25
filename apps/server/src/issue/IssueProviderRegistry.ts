import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SourceControlProviderKind } from "@t3tools/contracts";
import * as ForgejoTransport from "@t3tools/source-control-forgejo/server/ForgejoTransport";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";

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
function fromProviders(
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
const make = Effect.map(
  Effect.all([GitHubIssueProvider.make, ForgejoIssueProvider.make]),
  fromProviders,
);

// Drivers keep their host clients private, so issues build their own GitHub and Forgejo clients.
export const layer = Layer.effect(IssueProviderRegistry, make).pipe(
  Layer.provide(Layer.mergeAll(GitHubRest.layerWithDependencies, ForgejoTransport.layerWithCli)),
);
