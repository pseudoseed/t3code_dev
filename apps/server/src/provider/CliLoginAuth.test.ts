import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { makeCliLoginAuth, type CliLoginAuthOptions } from "./CliLoginAuth.ts";
import type { ProviderAuthController } from "./Services/ProviderAuthService.ts";

const instanceId = ProviderInstanceId.make("claudeAgent_work");
const owner = "owner-session";
const otherOwner = "other-session";

const MOCK_CLI = new URL("./testFixtures/cliLoginMockProvider.mjs", import.meta.url).pathname;

function invocation(mode: string, ...extra: ReadonlyArray<string>) {
  return { command: process.execPath, args: [MOCK_CLI, mode, ...extra], env: process.env };
}

interface Harness {
  readonly controller: ProviderAuthController;
  readonly authenticatedCount: Ref.Ref<number>;
  readonly signedOutCount: Ref.Ref<number>;
}

const makeHarness = Effect.fn("CliLoginAuth.test.makeHarness")(function* (
  overrides: Partial<CliLoginAuthOptions> = {},
) {
  const authenticatedCount = yield* Ref.make(0);
  const signedOutCount = yield* Ref.make(0);
  const controller = yield* makeCliLoginAuth({
    instanceId,
    providerLabel: "Claude",
    accountLabel: "your Anthropic account",
    completion: "code",
    authorizationUrlHosts: ["claude.com", "openai.com"],
    login: invocation("code"),
    logout: invocation("logout"),
    verifySignedIn: Effect.succeed(true),
    onAuthenticated: Ref.update(authenticatedCount, (count) => count + 1),
    onSignedOut: Ref.update(signedOutCount, (count) => count + 1),
    ...overrides,
  });
  return { controller, authenticatedCount, signedOutCount } satisfies Harness;
});

/**
 * Wait for the first state matching `match` on one client's view of the flow.
 * Forked before the action that causes the transition, so no update is missed.
 */
const awaitState = (
  controller: ProviderAuthController,
  match: (state: ProviderAuthState) => boolean,
  sessionId = owner,
) =>
  controller.subscribe(sessionId).pipe(
    Stream.filter(match),
    Stream.runHead,
    Effect.flatMap((head) =>
      head._tag === "Some" ? Effect.succeed(head.value) : Effect.die("stream ended early"),
    ),
    Effect.timeout("20 seconds"),
    Effect.forkScoped,
  );

const awaitPhase = (
  controller: ProviderAuthController,
  phase: ProviderAuthState["phase"],
  sessionId = owner,
) => awaitState(controller, (state) => state.phase === phase, sessionId);

/** The device flow publishes the URL first and the code on a later line. */
const awaitUserCode = (controller: ProviderAuthController, sessionId = owner) =>
  awaitState(controller, (state) => state.userCode !== null, sessionId);

it.layer(NodeServices.layer)("CliLoginAuth", (it) => {
  describe("code completion", () => {
    it.effect("publishes the authorization URL the CLI printed", () =>
      Effect.gen(function* () {
        const { controller } = yield* makeHarness();
        const waiting = yield* awaitPhase(controller, "waiting");

        yield* controller.start(owner);
        const state = yield* Fiber.join(waiting);

        expect(state.authorizationUrl).toBe(
          "https://claude.com/cai/oauth/authorize?code=true&state=test-state",
        );
        expect(state.completion).toBe("code");
        expect(state.flowId).not.toBeNull();
      }).pipe(Effect.scoped),
    );

    it.effect("signs in when the pasted code is accepted", () =>
      Effect.gen(function* () {
        const { controller, authenticatedCount } = yield* makeHarness();
        const waiting = yield* awaitPhase(controller, "waiting");
        yield* controller.start(owner);
        const pending = yield* Fiber.join(waiting);
        const succeeded = yield* awaitPhase(controller, "succeeded");

        yield* controller.complete(owner, {
          flowId: pending.flowId ?? "",
          callbackUrl: "good-code",
        });
        const state = yield* Fiber.join(succeeded);

        expect(state.phase).toBe("succeeded");
        expect(state.authorizationUrl).toBeNull();
        expect(yield* Ref.get(authenticatedCount)).toBe(1);
      }).pipe(Effect.scoped),
    );

    it.effect("fails with the provider's own reason when the code is rejected", () =>
      Effect.gen(function* () {
        const { controller, authenticatedCount } = yield* makeHarness();
        const waiting = yield* awaitPhase(controller, "waiting");
        yield* controller.start(owner);
        const pending = yield* Fiber.join(waiting);
        const failed = yield* awaitPhase(controller, "failed");

        yield* controller.complete(owner, {
          flowId: pending.flowId ?? "",
          callbackUrl: "wrong-code",
        });
        const state = yield* Fiber.join(failed);

        expect(state.message).toContain("Login failed");
        expect(yield* Ref.get(authenticatedCount)).toBe(0);
      }).pipe(Effect.scoped),
    );

    it.effect("treats a clean exit without stored credentials as a failure", () =>
      Effect.gen(function* () {
        const { controller, authenticatedCount } = yield* makeHarness({
          verifySignedIn: Effect.succeed(false),
        });
        const waiting = yield* awaitPhase(controller, "waiting");
        yield* controller.start(owner);
        const pending = yield* Fiber.join(waiting);
        const failed = yield* awaitPhase(controller, "failed");

        yield* controller.complete(owner, {
          flowId: pending.flowId ?? "",
          callbackUrl: "good-code",
        });
        const state = yield* Fiber.join(failed);

        expect(state.message).toContain("did not store a sign-in");
        expect(yield* Ref.get(authenticatedCount)).toBe(0);
      }).pipe(Effect.scoped),
    );

    it.effect("rejects a second code for the same flow", () =>
      Effect.gen(function* () {
        const { controller } = yield* makeHarness();
        const waiting = yield* awaitPhase(controller, "waiting");
        yield* controller.start(owner);
        const pending = yield* Fiber.join(waiting);
        const flowId = pending.flowId ?? "";

        yield* controller.complete(owner, { flowId, callbackUrl: "good-code" });
        const second = yield* controller
          .complete(owner, { flowId, callbackUrl: "good-code" })
          .pipe(Effect.flip);

        expect(second.detail).toContain("already sent");
      }).pipe(Effect.scoped),
    );
  });

  describe("device completion", () => {
    it.effect("publishes the verification URL and the one-time code", () =>
      Effect.gen(function* () {
        const { controller } = yield* makeHarness({
          completion: "none",
          login: invocation("device"),
        });
        const coded = yield* awaitUserCode(controller);

        yield* controller.start(owner);
        const state = yield* Fiber.join(coded);

        expect(state.authorizationUrl).toBe("https://auth.openai.com/codex/device");
        expect(state.userCode).toBe("ABCD-1234");
        expect(state.completion).toBe("none");
      }).pipe(Effect.scoped),
    );

    it.effect("finishes without the client sending anything back", () =>
      Effect.gen(function* () {
        const { controller, authenticatedCount } = yield* makeHarness({
          completion: "none",
          login: invocation("device"),
        });
        const succeeded = yield* awaitPhase(controller, "succeeded");

        yield* controller.start(owner);
        yield* Fiber.join(succeeded);

        expect(yield* Ref.get(authenticatedCount)).toBe(1);
      }).pipe(Effect.scoped),
    );

    it.effect("refuses a pasted code, since there is nothing to paste", () =>
      Effect.gen(function* () {
        const { controller } = yield* makeHarness({
          completion: "none",
          login: invocation("device"),
        });
        const waiting = yield* awaitPhase(controller, "waiting");
        yield* controller.start(owner);
        const pending = yield* Fiber.join(waiting);

        const error = yield* controller
          .complete(owner, { flowId: pending.flowId ?? "", callbackUrl: "ABCD-1234" })
          .pipe(Effect.flip);

        expect(error.detail).toContain("nothing to paste");
      }).pipe(Effect.scoped),
    );
  });

  describe("loopback redirect completion", () => {
    const loopbackHarness = () =>
      makeHarness({
        providerLabel: "Codex",
        completion: "redirectUrl",
        // Port 0 lets the fixture bind anywhere; the real CLI uses a fixed one.
        login: invocation("loopback", "0"),
      });

    it.effect("reads the loopback redirect out of the authorization URL", () =>
      Effect.gen(function* () {
        const { controller } = yield* loopbackHarness();
        const waiting = yield* awaitPhase(controller, "waiting");

        yield* controller.start(owner);
        const state = yield* Fiber.join(waiting);

        // The CLI, not our configuration, decides this is a redirect flow.
        expect(state.completion).toBe("redirectUrl");
        expect(state.authorizationUrl).toContain("redirect_uri=");
      }).pipe(Effect.scoped),
    );

    it.effect("delivers a pasted redirect to the CLI's own listener", () =>
      Effect.gen(function* () {
        const { controller, authenticatedCount } = yield* loopbackHarness();
        const waiting = yield* awaitPhase(controller, "waiting");
        yield* controller.start(owner);
        const pending = yield* Fiber.join(waiting);
        const redirectUri = new URL(pending.authorizationUrl ?? "").searchParams.get(
          "redirect_uri",
        );
        const succeeded = yield* awaitPhase(controller, "succeeded");

        yield* controller.complete(owner, {
          flowId: pending.flowId ?? "",
          callbackUrl: `${redirectUri}?code=granted&state=loopback-state`,
        });
        yield* Fiber.join(succeeded);

        expect(yield* Ref.get(authenticatedCount)).toBe(1);
      }).pipe(Effect.scoped),
    );

    it.effect("rejects a redirect whose state does not match the flow", () =>
      Effect.gen(function* () {
        const { controller } = yield* loopbackHarness();
        const waiting = yield* awaitPhase(controller, "waiting");
        yield* controller.start(owner);
        const pending = yield* Fiber.join(waiting);
        const redirectUri = new URL(pending.authorizationUrl ?? "").searchParams.get(
          "redirect_uri",
        );

        const error = yield* controller
          .complete(owner, {
            flowId: pending.flowId ?? "",
            callbackUrl: `${redirectUri}?code=granted&state=attacker-state`,
          })
          .pipe(Effect.flip);

        expect(error.detail).toContain("does not belong to the current sign-in");
      }).pipe(Effect.scoped),
    );

    it.effect("rejects a redirect pointed at a host that is not the listener", () =>
      Effect.gen(function* () {
        const { controller } = yield* loopbackHarness();
        const waiting = yield* awaitPhase(controller, "waiting");
        yield* controller.start(owner);
        const pending = yield* Fiber.join(waiting);

        const error = yield* controller
          .complete(owner, {
            flowId: pending.flowId ?? "",
            callbackUrl: "http://127.0.0.1:9/auth/callback?code=granted&state=loopback-state",
          })
          .pipe(Effect.flip);

        expect(error.detail).toContain("does not belong to the current sign-in");
      }).pipe(Effect.scoped),
    );
  });

  describe("one flow at a time", () => {
    it.effect("refuses to start a competing sign-in on the same instance", () =>
      Effect.gen(function* () {
        const { controller } = yield* makeHarness();
        const waiting = yield* awaitPhase(controller, "waiting");
        yield* controller.start(owner);
        yield* Fiber.join(waiting);

        // Concurrent sign-ins would race for one credential directory.
        const error = yield* controller.start(otherOwner).pipe(Effect.flip);

        expect(error.detail).toContain("already in progress");
      }).pipe(Effect.scoped),
    );

    it.effect("hides the URL and code from a client that did not start the flow", () =>
      Effect.gen(function* () {
        const { controller } = yield* makeHarness({
          completion: "none",
          login: invocation("device"),
        });
        const ownerWaiting = yield* awaitUserCode(controller);
        const otherWaiting = yield* awaitPhase(controller, "waiting", otherOwner);
        yield* controller.start(owner);

        expect((yield* Fiber.join(ownerWaiting)).userCode).toBe("ABCD-1234");
        const seenByOther = yield* Fiber.join(otherWaiting);
        expect(seenByOther.userCode).toBeNull();
        expect(seenByOther.authorizationUrl).toBeNull();
        expect(seenByOther.flowId).toBeNull();
      }).pipe(Effect.scoped),
    );

    it.effect("releases the instance after a cancelled sign-in", () =>
      Effect.gen(function* () {
        const { controller } = yield* makeHarness();
        const waiting = yield* awaitPhase(controller, "waiting");
        yield* controller.start(owner);
        const pending = yield* Fiber.join(waiting);

        yield* controller.cancel(owner, pending.flowId ?? "");
        const restarted = yield* controller.start(otherOwner);

        expect(restarted.phase).toBe("starting");
      }).pipe(Effect.scoped),
    );
  });

  describe("sign out", () => {
    it.effect("runs the provider's own logout and reports the result", () =>
      Effect.gen(function* () {
        const { controller, signedOutCount } = yield* makeHarness();

        const state = yield* controller.logout(Effect.void);

        expect(state.phase).toBe("idle");
        expect(yield* Ref.get(signedOutCount)).toBe(1);
      }).pipe(Effect.scoped),
    );

    it.effect("surfaces a failed sign-out instead of claiming success", () =>
      Effect.gen(function* () {
        const { controller, signedOutCount } = yield* makeHarness({
          logout: invocation("logout-fail"),
        });

        const error = yield* controller.logout(Effect.void).pipe(Effect.flip);

        expect(error.detail).toContain("Could not reach the credential store");
        expect(yield* Ref.get(signedOutCount)).toBe(0);
      }).pipe(Effect.scoped),
    );
  });

  it.effect("reports a binary it cannot run instead of hanging", () =>
    Effect.gen(function* () {
      const { controller } = yield* makeHarness({
        login: {
          command: "/nonexistent/t3code-missing-provider-binary",
          args: [],
          env: process.env,
        },
      });
      const failed = yield* awaitPhase(controller, "failed");

      yield* controller.start(owner);
      const state = yield* Fiber.join(failed);

      expect(state.message).toContain("binary path");
    }).pipe(Effect.scoped),
  );
});
