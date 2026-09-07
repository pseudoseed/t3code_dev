import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import {
  makeCodexSessionRuntime,
  type CodexSessionRuntimeSendTurnInput,
} from "./CodexSessionRuntime.ts";

const encodeScript = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.String,
      params: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);
const firstTurnId = wireFixture.responses.turnStart.turn.id;

const makeHarness = Effect.fn("makeSteeringHarness")(function* (
  script: Record<string, unknown> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-steer-" });
  const scriptPath = path.join(dir, "script.json");
  yield* fs.writeFileString(
    scriptPath,
    yield* encodeScript({
      rootThreadId: wireFixture.rootThreadId,
      notifications: [],
      holdTurnOpen: true,
      recordTurnRequests: true,
      ...script,
    }),
  );
  const runtime = yield* makeCodexSessionRuntime({
    threadId: ThreadId.make("codex-steer-test"),
    binaryPath: path.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh"),
    cwd: dir,
    runtimeMode: "full-access",
    environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
  });
  yield* runtime.start();
  const requests = fs
    .readFileString(`${scriptPath}.requests`)
    .pipe(
      Effect.flatMap((text) =>
        Effect.forEach(text.trim().split("\n"), (line) => decodeRequest(line)),
      ),
    );
  return { runtime, requests };
});

describe("Codex follow-up delivery", () => {
  it.effect(
    "delivers concurrent follow-ups and images into the active turn without interruption",
    () =>
      Effect.gen(function* () {
        const { runtime, requests } = yield* makeHarness();
        const first = yield* runtime.sendTurn({ input: "keep working" });
        const followUps = [
          {
            input: "include tests",
            attachments: [{ type: "image" as const, url: "data:image/png;base64,abc" }],
          },
          { input: "preserve the existing API" },
        ];
        const results = yield* Effect.forEach(followUps, runtime.sendTurn, {
          concurrency: "unbounded",
        });
        assert.deepEqual(
          results.map((result) => result.turnId),
          [first.turnId, first.turnId],
        );
        const recorded = yield* requests;
        assert.deepEqual(
          recorded.map((request) => request.method),
          ["turn/start", "turn/steer", "turn/steer"],
        );
        assert.deepEqual(
          recorded.slice(1).map((request) => request.params),
          followUps.map((input) => ({
            threadId: wireFixture.rootThreadId,
            expectedTurnId: first.turnId,
            input: [{ type: "text", text: input.input }, ...(input.attachments ?? [])],
          })),
        );
        assert.equal((yield* runtime.getSession).activeTurnId, first.turnId);
        yield* runtime.interruptTurn();
        assert.deepEqual((yield* requests).at(-1), {
          method: "turn/interrupt",
          params: { threadId: wireFixture.rootThreadId, turnId: first.turnId },
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts a new turn after the steered turn completes", () =>
    Effect.gen(function* () {
      const { runtime, requests } = yield* makeHarness({ completeOnSteer: true });
      const completed = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* runtime.sendTurn({ input: "first" });
      yield* runtime.sendTurn({ input: "follow-up" });
      const events = yield* Fiber.join(completed);
      assert.equal(events.filter((event) => event.method === "turn/started").length, 1);
      yield* runtime.sendTurn({ input: "next task" });
      assert.deepEqual(
        (yield* requests).map((request) => request.method),
        ["turn/start", "turn/steer", "turn/start"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  const configuration: CodexSessionRuntimeSendTurnInput = {
    model: "gpt-5.3-codex",
    effort: "medium",
    serviceTier: "priority",
    interactionMode: "default",
  };
  for (const change of [
    { model: "gpt-5.4" },
    { effort: "high" },
    { serviceTier: "flex" },
    { interactionMode: "plan" },
  ] satisfies Array<CodexSessionRuntimeSendTurnInput>) {
    it.effect(`preserves ${Object.keys(change)[0]} changes while busy`, () =>
      Effect.gen(function* () {
        const { runtime, requests } = yield* makeHarness();
        yield* runtime.sendTurn({ ...configuration, input: "first" });
        yield* runtime.sendTurn({ ...configuration, ...change, input: "updated settings" });
        yield* runtime.sendTurn({ ...configuration, ...change, input: "follow-up" });
        const recorded = yield* requests;
        assert.deepEqual(
          recorded.map((request) => request.method),
          ["turn/start", "turn/start", "turn/steer"],
        );
        const { interactionMode, ...overrides } = change;
        assert.containSubset(recorded[1]?.params, overrides);
        if (interactionMode) {
          assert.containSubset(recorded[1]?.params.collaborationMode, { mode: interactionMode });
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  for (const error of [
    { code: -32601, message: "Method not found: turn/steer" },
    { code: -32600, message: "no active turn to steer" },
    { code: -32600, message: `expected active turn id ${firstTurnId} but found another-turn` },
  ]) {
    it.effect(`falls back once after the explicit rejection: ${error.message}`, () =>
      Effect.gen(function* () {
        const { runtime, requests } = yield* makeHarness({ steerError: error });
        yield* runtime.sendTurn({ input: "first" });
        yield* runtime.sendTurn({ input: "follow-up" });
        assert.deepEqual(
          (yield* requests).map((request) => request.method),
          ["turn/start", "turn/steer", "turn/start"],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  for (const script of [
    { steerError: { code: -32000, message: "cannot steer a review turn" } },
    { steerError: { code: -32602, message: "invalid image" } },
    { steerResult: { unexpected: true } },
  ]) {
    it.effect(`does not retry or disturb active work after ${JSON.stringify(script)}`, () =>
      Effect.gen(function* () {
        const { runtime, requests } = yield* makeHarness(script);
        const first = yield* runtime.sendTurn({ input: "first" });
        const result = yield* runtime.sendTurn({ input: "follow-up" }).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.deepEqual(
          (yield* requests).map((request) => request.method),
          ["turn/start", "turn/steer"],
        );
        assert.equal((yield* runtime.getSession).activeTurnId, first.turnId);
        assert.equal((yield* runtime.getSession).status, "running");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
});
