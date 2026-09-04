/**
 * Per-instance credential directories.
 *
 * A provider CLI keeps one signed-in account per credential directory, so two
 * instances of the same provider need two directories or the second sign-in
 * overwrites the first. Users should not have to know that, so T3 Code
 * provisions a directory for any instance that does not already have one.
 *
 * The rule has one deliberate exception. The instance whose id equals its
 * driver kind is the one migrated from the single-instance world; it keeps
 * pointing at the provider's own default home (`~/.claude`, `~/.codex`) so an
 * existing sign-in, and everything else the user has in that directory, keeps
 * working untouched. Every additional instance is new by definition and gets
 * its own directory.
 *
 * @module provider/providerCredentialHome
 */
import {
  defaultInstanceIdForDriver,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export interface ProviderCredentialHomeInput {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  /** The instance's configured path. A non-empty value always wins. */
  readonly configuredPath: string;
  /** `ServerConfig.providerHomesDir`. */
  readonly providerHomesDir: string;
}

/**
 * Resolve the credential directory for one instance, creating it when T3 Code
 * is the one provisioning it.
 *
 * Returns an empty string to mean "use the provider's own default home", which
 * is how both driver settings already encode an unset path.
 */
export const resolveProviderCredentialHome = Effect.fn("resolveProviderCredentialHome")(function* (
  input: ProviderCredentialHomeInput,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const configured = input.configuredPath.trim();
  if (configured.length > 0) return configured;
  if (input.instanceId === defaultInstanceIdForDriver(input.driverKind)) return "";

  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const home = path.join(input.providerHomesDir, input.instanceId);
  // A directory we cannot create is not worth failing instance startup over:
  // falling back to the shared home leaves the instance usable and the sign-in
  // flow reports the real problem when the user tries to use it.
  const created = yield* fileSystem.makeDirectory(home, { recursive: true }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  return created ? home : "";
});
