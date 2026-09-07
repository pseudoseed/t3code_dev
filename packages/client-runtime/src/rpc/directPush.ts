import type { DirectPushRegistration } from "@t3tools/contracts";
import { Effect, Option, Schema, SubscriptionRef } from "effect";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  buildEnvironmentAuthHeaders,
  withEnvironmentCredentials,
} from "../state/environmentHttpAuth.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "./http.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";

class DirectPushDisconnected extends Schema.TaggedErrorClass<DirectPushDisconnected>()(
  "DirectPushDisconnected",
  {},
) {}
export const requestDirectPush = Effect.fn("requestDirectPush")(function* (
  input:
    | { readonly action: "status" | "unregister" }
    | { readonly action: "register"; readonly registration: DirectPushRegistration },
) {
  const supervisor = yield* EnvironmentSupervisor;
  const prepared = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isNone(prepared)) return yield* new DirectPushDisconnected();
  const connection = prepared.value;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const url = environmentEndpointUrl(connection.httpBaseUrl, `/api/push/${input.action}`);
  const client = yield* makeEnvironmentHttpApiClient(connection.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    connection.httpAuthorization,
    input.action === "status" ? "GET" : "POST",
    url,
    signer,
  );
  const request =
    input.action === "register"
      ? client.directPush.register({ headers, payload: input.registration })
      : input.action === "status"
        ? client.directPush.status({ headers })
        : client.directPush.unregister({ headers }).pipe(Effect.as(null));
  return yield* executeEnvironmentHttpRequest(
    url,
    30_000,
    withEnvironmentCredentials(connection.httpAuthorization, request),
  );
});
