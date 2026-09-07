import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { Effect } from "effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { requireEnvironmentScope, failEnvironmentInternal } from "../auth/http.ts";
import { DirectPush } from "./DirectPush.ts";

export const directPushHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "directPush",
  Effect.fnUntraced(function* (handlers) {
    const push = yield* DirectPush;
    return handlers
      .handle(
        "status",
        Effect.fn("directPush.status")(function* () {
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          return yield* push
            .status(principal.sessionId)
            .pipe(Effect.catch(() => failEnvironmentInternal("internal_error")));
        }),
      )
      .handle(
        "register",
        Effect.fn("directPush.register")(function* ({ payload }) {
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          return yield* push
            .register(principal.sessionId, payload)
            .pipe(Effect.catch(() => failEnvironmentInternal("internal_error")));
        }),
      )
      .handle(
        "unregister",
        Effect.fn("directPush.unregister")(function* () {
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const principal = yield* EnvironmentAuthenticatedPrincipal;
          yield* push
            .unregister(principal.sessionId)
            .pipe(Effect.catch(() => failEnvironmentInternal("internal_error")));
          return { ok: true };
        }),
      );
  }),
);
