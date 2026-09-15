import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ForgejoApiError, type ForgejoApiShape } from "./ForgejoApi.ts";
import { ForgejoCli, type ForgejoCliError } from "./ForgejoCli.ts";

/** Shared transport for the fork's issue and review operations, using upstream's fj/tea login selection. */
export class ForgejoTransport extends Context.Service<
  ForgejoTransport,
  Pick<ForgejoApiShape, "request" | "resolveLocator">
>()("t3/sourceControl/ForgejoTransport") {}

const make = Effect.gen(function* () {
  const cli = yield* ForgejoCli;
  const failure = (operation: string) => (cause: ForgejoCliError) =>
    new ForgejoApiError({
      operation,
      detail: cause.detail,
      ...(cause.httpStatus === undefined ? {} : { status: cause.httpStatus }),
      cause,
    });
  return ForgejoTransport.of({
    request: (input) =>
      cli
        .api({
          cwd: input.cwd ?? ".",
          host: input.host,
          path: input.path.replace(/^\//, ""),
          method: input.method,
          ...(input.body === undefined ? {} : { body: JSON.parse(input.body) }),
        })
        .pipe(
          Effect.mapError(failure(input.operation)),
          Effect.map((result) => ({
            status: 200,
            body:
              input.maxBytes === undefined ? result.stdout : result.stdout.slice(0, input.maxBytes),
            truncated:
              result.stdoutTruncated ||
              (input.maxBytes !== undefined && result.stdout.length > input.maxBytes),
          })),
        ),
    resolveLocator: (input) =>
      cli.resolveRepository(input).pipe(
        Effect.mapError(failure("resolveLocator")),
        Effect.map((repo) => {
          const url = new URL(repo.baseUrl);
          const [owner = "", name = ""] = repo.repository.split("/");
          return {
            host: url.host,
            owner,
            repo: name,
            scheme: url.protocol === "http:" ? ("http" as const) : ("https" as const),
          };
        }),
      ),
  });
});

export const layer = Layer.effect(ForgejoTransport, make);
