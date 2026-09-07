import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { loadApnsConfiguration } from "./ApnsTransport.ts";

const settings = {
  keyFile: "apple.p8",
  keyId: "FILEKEY",
  teamId: "FILETEAM",
  bundleId: "test.file.app",
};
const settingsJson = JSON.stringify(settings);

const fixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-apns-config-" });
  const key = yield* Effect.sync(
    () => NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey,
  );
  const pem = yield* Effect.sync(() => key.export({ type: "pkcs8", format: "pem" }).toString());
  const keyFile = path.join(directory, settings.keyFile);
  const configFile = path.join(directory, "apns.json");
  yield* fs.writeFileString(keyFile, pem, { mode: 0o600 });
  yield* fs.writeFileString(configFile, settingsJson, { mode: 0o600 });
  return { fs, path, directory, keyFile, configFile, key };
});

it.layer(NodeServices.layer)("private APNs configuration", (it) => {
  it.effect("loads a persisted key relative to this instance's configuration on each startup", () =>
    Effect.gen(function* () {
      const { directory, key } = yield* fixture();
      const first = yield* loadApnsConfiguration(directory, {});
      const restarted = yield* loadApnsConfiguration(directory, {});
      assert.strictEqual(first?.bundleId, settings.bundleId);
      assert.strictEqual(restarted?.keyId, settings.keyId);
      assert.strictEqual(restarted?.teamId, settings.teamId);
      assert.isTrue(first!.key.equals(key));
      assert.isTrue(restarted!.key.equals(key));
    }),
  );

  it.effect("leaves another instance without a configuration disabled", () =>
    Effect.gen(function* () {
      const { fs, directory } = yield* fixture();
      const other = yield* fs.makeTempDirectoryScoped({ prefix: "t3-apns-other-" });
      assert.isNotNull(yield* loadApnsConfiguration(directory, {}));
      assert.isNull(yield* loadApnsConfiguration(other, {}));
    }),
  );

  it.effect("uses complete environment overrides without reading a broken configuration file", () =>
    Effect.gen(function* () {
      const { fs, directory, keyFile, configFile } = yield* fixture();
      yield* fs.writeFileString(configFile, "invalid json");
      const result = yield* loadApnsConfiguration(directory, {
        T3CODE_APNS_KEY_FILE: keyFile,
        T3CODE_APNS_KEY_ID: "ENVKEY",
        T3CODE_APNS_TEAM_ID: "ENVTEAM",
        T3CODE_APNS_BUNDLE_ID: "test.env.app",
      });
      assert.strictEqual(result?.bundleId, "test.env.app");
      assert.strictEqual(result?.teamId, "ENVTEAM");
      assert.strictEqual(result?.keyId, "ENVKEY");
    }),
  );

  it.effect("rejects partial overrides without borrowing credentials from the file", () =>
    Effect.gen(function* () {
      const { directory } = yield* fixture();
      const error = yield* loadApnsConfiguration(directory, {
        T3CODE_APNS_TEAM_ID: "OTHERTEAM",
      }).pipe(Effect.flip);
      assert.include(error.message, "all four T3CODE_APNS");
    }),
  );

  it.effect("reports invalid JSON and missing fields without including file contents", () =>
    Effect.gen(function* () {
      const { fs, directory, configFile } = yield* fixture();
      for (const invalid of ["private-value", '{"keyFile":"private-value"}']) {
        yield* fs.writeFileString(configFile, invalid);
        const error = yield* loadApnsConfiguration(directory, {}).pipe(Effect.flip);
        assert.include(error.message, "Invalid secrets/apns.json");
        assert.notInclude(error.message, "private-value");
      }
    }),
  );

  it.effect("rejects missing or invalid signing keys without exposing key contents", () =>
    Effect.gen(function* () {
      const { fs, directory, keyFile } = yield* fixture();
      yield* fs.remove(keyFile);
      const missing = yield* loadApnsConfiguration(directory, {}).pipe(Effect.flip);
      assert.include(missing.message, "Could not read");
      yield* fs.writeFileString(keyFile, "private-invalid-key");
      const invalid = yield* loadApnsConfiguration(directory, {}).pipe(Effect.flip);
      assert.include(invalid.message, "P-256");
      assert.notInclude(invalid.message, "private-invalid-key");
    }),
  );
});
