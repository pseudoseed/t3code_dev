/**
 * Issues for one project at a time.
 *
 * The panel follows the project it was opened beside, so unlike the change request service this
 * one never spans a workspace: it resolves one project to one repository on one host, and asks
 * that host. What it shares with its neighbour is how a self-hosted remote is recognised, since
 * an instance that carries no well-known hostname is only identified by asking its CLI.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  IssueOperationError,
  IssueUnavailableError,
  pullRequestHostOf,
  type IssueCreateResult,
  type IssueDetail,
  type IssueListEntry,
  type IssueListInput,
  type IssueListResult,
  type IssueProviderSummary,
  type ProjectId,
  type SourceControlProviderKind,
} from "@t3tools/contracts";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { repositoryIdentityOf } from "../pullRequest/PullRequestService.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { IssueProviderRegistry } from "./IssueProviderRegistry.ts";
import type { IssueProviderApi, IssueProviderError } from "./IssueProvider.ts";

const DEFAULT_LIST_LIMIT = 50;

export type IssueError = IssueUnavailableError | IssueOperationError;

interface ResolvedProject {
  readonly api: IssueProviderApi;
  readonly cwd: string;
  readonly repository: string;
  readonly host: string;
  readonly kind: SourceControlProviderKind;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
}

export class IssueService extends Context.Service<
  IssueService,
  {
    readonly list: (input: IssueListInput) => Effect.Effect<IssueListResult, IssueError>;
    /**
     * `repository` is accepted and ignored: the project's own repository is authoritative, and
     * a caller that does not know it may leave it out.
     */
    readonly detail: (input: {
      readonly projectId: ProjectId;
      readonly repository?: string | undefined;
      readonly number: number;
    }) => Effect.Effect<IssueDetail, IssueError>;
    readonly comment: (input: {
      readonly projectId: ProjectId;
      readonly repository?: string | undefined;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, IssueError>;
    readonly create: (input: {
      readonly projectId: ProjectId;
      readonly title: string;
      readonly body?: string | undefined;
    }) => Effect.Effect<IssueCreateResult, IssueError>;
    readonly setState: (input: {
      readonly projectId: ProjectId;
      readonly repository?: string | undefined;
      readonly number: number;
      readonly state: "open" | "closed";
    }) => Effect.Effect<void, IssueError>;
  }
>()("t3/issue/IssueService") {}

export const make = Effect.gen(function* () {
  const registry = yield* IssueProviderRegistry;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const sourceControlProviders = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const toError = (error: IssueProviderError): IssueError =>
    error.reason === "missing-tool"
      ? new IssueUnavailableError({
          reason: "cli-missing",
          provider: error.provider,
          detail: error.detail,
        })
      : error.reason === "unauthenticated"
        ? new IssueUnavailableError({
            reason: "cli-unauthenticated",
            provider: error.provider,
            detail: error.detail,
          })
        : new IssueOperationError({ operation: error.operation, detail: error.detail });

  /**
   * One project, as a host that can be asked. A remote whose provider could not be told from its
   * URL alone is put to the source control registry, which asks each CLI whether the host is one
   * it is signed in to — the step that makes a self-hosted Forgejo work at all.
   */
  const resolveProject = (projectId: ProjectId): Effect.Effect<ResolvedProject, IssueError> =>
    projections.getShellSnapshot().pipe(
      Effect.mapError(
        () =>
          new IssueOperationError({
            operation: "resolveProject",
            detail: "The project list could not be read.",
          }),
      ),
      Effect.flatMap((snapshot) => {
        const project = snapshot.projects.find((candidate) => candidate.id === projectId);
        const identity = project?.repositoryIdentity;
        const repository = project === undefined ? null : repositoryIdentityOf(project);
        if (project === undefined || !identity || repository === null) {
          return Effect.fail(
            new IssueUnavailableError({
              reason: "provider-unsupported",
              detail: "This project has no repository to read issues from.",
            }),
          );
        }

        const declared = identity.provider as SourceControlProviderKind;
        const refined =
          declared !== "unknown"
            ? Effect.succeed(declared)
            : sourceControlProviders.resolveHandle({ cwd: project.workspaceRoot }).pipe(
                Effect.map((handle) => handle.context?.provider.kind ?? "unknown"),
                Effect.orElseSucceed((): SourceControlProviderKind => "unknown"),
              );

        return refined.pipe(
          Effect.flatMap((kind) => {
            const api = registry.get(kind);
            if (api === null) {
              return Effect.fail(
                new IssueUnavailableError({
                  reason: "provider-unsupported",
                  provider: kind,
                  detail:
                    kind === "unknown"
                      ? "This project's host could not be identified."
                      : `Issues are not supported on ${kind} yet.`,
                }),
              );
            }
            return Effect.succeed({
              api,
              cwd: project.workspaceRoot,
              repository,
              host: pullRequestHostOf(identity, kind),
              kind,
              projectId,
              projectTitle: project.title,
            } satisfies ResolvedProject);
          }),
        );
      }),
    );

  const providerSummary = (
    resolved: ResolvedProject,
    disabledReason?: string,
  ): IssueProviderSummary => ({
    host: resolved.host,
    kind: resolved.kind,
    projectCount: 1,
    // A tracker that is switched off is a host this cannot be read from, which is what the
    // panel needs to know to explain an empty list rather than claim there are no issues.
    configured: disabledReason === undefined,
    searchesOnHost: resolved.api.capabilities.search,
    detail: disabledReason ?? null,
  });

  return IssueService.of({
    list: (input) =>
      resolveProject(input.projectId).pipe(
        Effect.flatMap((resolved) =>
          resolved.api.getViewer({ cwd: resolved.cwd }).pipe(
            // Involvement narrowing wants a name; without one the listing is not narrowed.
            Effect.orElseSucceed(() => ""),
            Effect.flatMap((viewer) =>
              resolved.api.listIssues({
                cwd: resolved.cwd,
                repository: resolved.repository,
                host: resolved.host,
                state: input.state,
                involvement: input.involvement ?? "all",
                viewer,
                limit: input.limit ?? DEFAULT_LIST_LIMIT,
                ...(input.query === undefined ? {} : { query: input.query }),
              }),
            ),
            Effect.map((page): IssueListResult => {
              const query = input.query?.trim().toLowerCase() ?? "";
              // A host that does not search its own issues answers unnarrowed, so the rows are
              // narrowed here instead. One that does has already done it, and this changes
              // nothing.
              const rows =
                query.length === 0 || resolved.api.capabilities.search
                  ? page.items
                  : page.items.filter((item) => item.title.toLowerCase().includes(query));
              return {
                entries: rows.map((item): IssueListEntry => ({
                  ...item,
                  provider: resolved.kind,
                  host: resolved.host,
                  projectId: resolved.projectId,
                  projectTitle: resolved.projectTitle,
                  repository: resolved.repository,
                })),
                provider: providerSummary(resolved),
                errors: [],
                truncated: page.truncated,
              };
            }),
            Effect.mapError(toError),
          ),
        ),
      ),

    detail: (input) =>
      resolveProject(input.projectId).pipe(
        Effect.flatMap((resolved) =>
          resolved.api
            .getIssue({
              cwd: resolved.cwd,
              repository: resolved.repository,
              host: resolved.host,
              number: input.number,
            })
            .pipe(
              Effect.map((detail): IssueDetail => ({
                ...detail,
                provider: resolved.kind,
                host: resolved.host,
                projectId: resolved.projectId,
                projectTitle: resolved.projectTitle,
                repository: resolved.repository,
                capabilities: resolved.api.capabilities,
              })),
              Effect.mapError(toError),
            ),
        ),
      ),

    comment: (input) =>
      resolveProject(input.projectId).pipe(
        Effect.flatMap((resolved) =>
          resolved.api.capabilities.comment
            ? resolved.api
                .comment({
                  cwd: resolved.cwd,
                  repository: resolved.repository,
                  host: resolved.host,
                  number: input.number,
                  body: input.body,
                })
                .pipe(Effect.mapError(toError))
            : Effect.fail(
                new IssueOperationError({
                  operation: "comment",
                  detail: `${resolved.kind} does not take issue comments here.`,
                }),
              ),
        ),
      ),

    create: (input) =>
      resolveProject(input.projectId).pipe(
        Effect.flatMap((resolved) =>
          resolved.api.capabilities.create
            ? resolved.api
                .createIssue({
                  cwd: resolved.cwd,
                  repository: resolved.repository,
                  host: resolved.host,
                  title: input.title,
                  body: input.body ?? "",
                })
                .pipe(Effect.mapError(toError))
            : Effect.fail(
                new IssueOperationError({
                  operation: "create",
                  detail: `${resolved.kind} does not open issues here.`,
                }),
              ),
        ),
      ),

    setState: (input) =>
      resolveProject(input.projectId).pipe(
        Effect.flatMap((resolved) =>
          resolved.api.capabilities.close
            ? resolved.api
                .setState({
                  cwd: resolved.cwd,
                  repository: resolved.repository,
                  host: resolved.host,
                  number: input.number,
                  state: input.state,
                })
                .pipe(Effect.mapError(toError))
            : Effect.fail(
                new IssueOperationError({
                  operation: "setState",
                  detail: `${resolved.kind} does not close issues here.`,
                }),
              ),
        ),
      ),
  });
});

export const layer = Layer.effect(IssueService, make);
