import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveProviderCredentialHome } from "./providerCredentialHome.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");

const makeHomesDir = Effect.fn("providerCredentialHome.test.makeHomesDir")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-provider-homes-" });
});

it.layer(NodeServices.layer)("resolveProviderCredentialHome", (it) => {
  describe("existing sign-ins", () => {
    it.effect("leaves the migrated instance on the provider's own default home", () =>
      Effect.gen(function* () {
        const providerHomesDir = yield* makeHomesDir();

        const home = yield* resolveProviderCredentialHome({
          driverKind: CLAUDE,
          // The instance id that equals its driver kind is the one migrated
          // from the single-instance world.
          instanceId: ProviderInstanceId.make("claudeAgent"),
          configuredPath: "",
          providerHomesDir,
        });

        expect(home).toBe("");
      }).pipe(Effect.scoped),
    );

    it.effect("never overrides a path the user configured", () =>
      Effect.gen(function* () {
        const providerHomesDir = yield* makeHomesDir();

        const home = yield* resolveProviderCredentialHome({
          driverKind: CLAUDE,
          instanceId: ProviderInstanceId.make("claudeAgent_work"),
          configuredPath: "  ~/my-claude-home  ",
          providerHomesDir,
        });

        expect(home).toBe("~/my-claude-home");
      }).pipe(Effect.scoped),
    );
  });

  describe("additional instances", () => {
    it.effect("provisions a directory that exists on disk", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const providerHomesDir = yield* makeHomesDir();

        const home = yield* resolveProviderCredentialHome({
          driverKind: CLAUDE,
          instanceId: ProviderInstanceId.make("claudeAgent_work"),
          configuredPath: "",
          providerHomesDir,
        });

        expect(home).toBe(path.join(providerHomesDir, "claudeAgent_work"));
        expect(yield* fileSystem.exists(home)).toBe(true);
      }).pipe(Effect.scoped),
    );

    it.effect("gives two instances of one driver separate directories", () =>
      Effect.gen(function* () {
        const providerHomesDir = yield* makeHomesDir();
        const resolve = (instanceId: string) =>
          resolveProviderCredentialHome({
            driverKind: CLAUDE,
            instanceId: ProviderInstanceId.make(instanceId),
            configuredPath: "",
            providerHomesDir,
          });

        const personal = yield* resolve("claudeAgent_personal");
        const work = yield* resolve("claudeAgent_work");

        // This is the whole multi-subscription guarantee: one credential
        // directory per instance means one signed-in account per instance.
        expect(personal).not.toBe(work);
      }).pipe(Effect.scoped),
    );

    it.effect("is stable across restarts so a sign-in survives", () =>
      Effect.gen(function* () {
        const providerHomesDir = yield* makeHomesDir();
        const resolve = () =>
          resolveProviderCredentialHome({
            driverKind: CLAUDE,
            instanceId: ProviderInstanceId.make("claudeAgent_work"),
            configuredPath: "",
            providerHomesDir,
          });

        expect(yield* resolve()).toBe(yield* resolve());
      }).pipe(Effect.scoped),
    );
  });

  it.effect("falls back to the default home when the directory cannot be created", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* makeHomesDir();
      // A regular file where the root directory should be makes every
      // makeDirectory below it fail.
      const providerHomesDir = path.join(parent, "blocked");
      yield* fileSystem.writeFileString(providerHomesDir, "not a directory");

      const home = yield* resolveProviderCredentialHome({
        driverKind: CLAUDE,
        instanceId: ProviderInstanceId.make("claudeAgent_work"),
        configuredPath: "",
        providerHomesDir,
      });

      expect(home).toBe("");
    }).pipe(Effect.scoped),
  );
});
