import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { makeCliLoginAuth } from "../provider/CliLoginAuth.ts";
import { findMcpAuthorizationUrl } from "../provider/cliLoginOutput.ts";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import { PtyAdapter } from "../terminal/PtyAdapter.ts";
import { runMcpPtyLogin } from "./McpPtyLogin.ts";

it.layer(NodeServices.layer)("MCP terminal authorization", (it) => {
  it.effect("completes the TTY-only flow using an OSC link and a remotely pasted redirect", () =>
    Effect.gen(function* () {
      const pty = yield* NodePtyAdapter.make();
      const login = {
        command: process.execPath,
        args: [
          new URL("../provider/testFixtures/cliLoginMockProvider.mjs", import.meta.url).pathname,
          "mcp-tty",
        ],
        cwd: process.cwd(),
        env: process.env,
      };
      const controller = yield* makeCliLoginAuth({
        instanceId: ProviderInstanceId.make("claude_fixture"),
        providerLabel: "Claude MCP",
        accountLabel: "fixture",
        completion: "redirectUrl",
        redirectDelivery: "stdin",
        authorizationUrlHosts: [],
        findAuthorizationUrl: findMcpAuthorizationUrl,
        login,
        logout: login,
        runLogin: (input, onLine) =>
          runMcpPtyLogin(login, input, onLine).pipe(Effect.provideService(PtyAdapter, pty)),
        verifySignedIn: Effect.succeed(true),
        onAuthenticated: Effect.void,
        onSignedOut: Effect.void,
      });
      const waitFor = (phase: ProviderAuthState["phase"], owner = "owner") =>
        controller.subscribe(owner).pipe(
          Stream.filter((state) => state.phase === phase),
          Stream.runHead,
          Effect.flatMap((state) =>
            state._tag === "Some" ? Effect.succeed(state.value) : Effect.die("flow ended"),
          ),
          Effect.forkScoped,
        );
      const waiting = yield* waitFor("waiting");
      yield* controller.start("owner");
      const state = yield* Fiber.join(waiting);
      expect(state.authorizationUrl).toContain("issuer.example");
      const hidden = yield* controller.subscribe("other-device").pipe(Stream.runHead);
      expect(hidden._tag === "Some" && hidden.value.authorizationUrl).toBeNull();
      const denied = yield* controller
        .complete("other-device", {
          flowId: state.flowId!,
          callbackUrl: "http://localhost:1234/callback?state=mcp-state&code=fixture-code",
        })
        .pipe(Effect.result);
      expect(denied._tag).toBe("Failure");
      const wrongState = yield* controller
        .complete("owner", {
          flowId: state.flowId!,
          callbackUrl: "http://localhost:1234/callback?state=wrong&code=fixture-code",
        })
        .pipe(Effect.result);
      expect(wrongState._tag).toBe("Failure");
      const succeeded = yield* waitFor("succeeded");
      yield* controller.complete("owner", {
        flowId: state.flowId!,
        callbackUrl: "http://localhost:1234/callback?state=mcp-state&code=fixture-code",
      });
      expect((yield* Fiber.join(succeeded)).phase).toBe("succeeded");
    }).pipe(Effect.scoped),
  );
});
