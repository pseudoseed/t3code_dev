import { describe, expect, it } from "@effect/vitest";
import { UsageLimitSourceId, type UsageLimitSourceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const sourceId = UsageLimitSourceId.make("hub");
const input = { sourceId, accountId: "claude.json" };
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      auth_index: Schema.String,
      method: Schema.optional(Schema.String),
      url: Schema.optional(Schema.String),
    }),
  ),
);

function fixture(overrides: Partial<UsageLimitSourceConfig> = {}, resetStatus = 200) {
  const requests: Array<{ path: string; authIndex: string | undefined }> = [];
  const upstream = { utilization: 40 };
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const body =
        request.body._tag === "Uint8Array"
          ? decodeRequest(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ path, authIndex: body?.auth_index });
      if (path === "/v0/management/auth-files") {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            files: [{ id: "claude.json", auth_index: "claude-index", provider: "claude" }],
          }),
        );
      }
      if (path === "/v0/management/reset-quota") {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ status: "ok" }, { status: resetStatus }),
        );
      }
      if (path === "/api/usage") {
        return HttpClientResponse.fromWeb(request, Response.json({ companies: [] }));
      }
      expect(path).toBe("/v0/management/api-call");
      expect(body?.method).toBe("GET");
      expect(body?.url).toBe("https://api.anthropic.com/api/oauth/usage");
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          status_code: 200,
          body: encodeJson({
            five_hour: { utilization: upstream.utilization, resets_at: null },
          }),
        }),
      );
    }),
  );
  const settings = ServerSettings.layerTest({
    usageLimitSources: {
      [sourceId]: {
        kind: "cliproxy",
        url: "http://hub.test:8317",
        enabled: true,
        managementKey: "test-key",
        ...overrides,
      },
    },
  });
  const background = BackgroundPolicy.layer.pipe(
    Layer.provide(
      Layer.merge(
        settings,
        Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make()),
      ),
    ),
  );
  return {
    requests,
    upstream,
    layer: UsageLimitSources.layer.pipe(
      Layer.provide(
        Layer.mergeAll(settings, background, Layer.succeed(HttpClient.HttpClient, http)),
      ),
    ),
  };
}

describe("UsageLimitSources.clearCooldown", () => {
  it.effect("clears the selected hub account and publishes freshly read usage", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const service = yield* UsageLimitSources.UsageLimitSources;
      yield* service.refresh;
      expect((yield* service.current)[0]?.accounts[0]?.usageLimits.windows[0]?.usedPercent).toBe(
        40,
      );
      test.upstream.utilization = 0;
      test.requests.length = 0;
      yield* service.clearCooldown(input);
      expect(test.requests.filter((request) => request.path.endsWith("reset-quota"))).toEqual([
        { path: "/v0/management/reset-quota", authIndex: "claude-index" },
      ]);
      expect((yield* service.current)[0]?.accounts[0]?.usageLimits.windows[0]?.usedPercent).toBe(0);
    }).pipe(Effect.provide(test.layer));
  });

  for (const [name, overrides] of [
    ["disabled", { enabled: false }],
    ["dashboard", { kind: "aiusage" }],
    ["missing management key", { managementKey: "" }],
  ] as const) {
    it.effect(`rejects a ${name} source without clearing any account`, () => {
      const test = fixture(overrides);
      return Effect.gen(function* () {
        const service = yield* UsageLimitSources.UsageLimitSources;
        yield* service.refresh;
        test.requests.length = 0;
        expect((yield* service.clearCooldown(input).pipe(Effect.result))._tag).toBe("Failure");
        expect(test.requests).toEqual([]);
      }).pipe(Effect.provide(test.layer));
    });
  }

  it.effect("rejects a removed source without touching another hub", () => {
    const test = fixture();
    return Effect.gen(function* () {
      const service = yield* UsageLimitSources.UsageLimitSources;
      yield* service.refresh;
      test.requests.length = 0;
      const result = yield* service
        .clearCooldown({ ...input, sourceId: UsageLimitSourceId.make("missing") })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(test.requests).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  });

  it.effect("reports a refused reset without publishing a successful refresh", () => {
    const test = fixture({}, 503);
    return Effect.gen(function* () {
      const service = yield* UsageLimitSources.UsageLimitSources;
      yield* service.refresh;
      const before = yield* service.current;
      test.upstream.utilization = 0;
      expect((yield* service.clearCooldown(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* service.current).toEqual(before);
    }).pipe(Effect.provide(test.layer));
  });
});
