/** The current completed-file model and its still-supported predecessor. */
export const DIARIZER_MODEL_ID = "fluid-diarizer-offline";
export const LEGACY_DIARIZER_MODEL_ID = "fluid-diarizer";

/** Measured download size of the offline segmentation, embedding, and clustering assets. */
export const DIARIZER_DOWNLOAD_BYTES = 22 * 1024 * 1024;

/** Keep existing filtering active until an explicit model update completes. */
export function resolveDiarizerInstallation(installedModelIds: readonly string[]) {
  const currentInstalled = installedModelIds.includes(DIARIZER_MODEL_ID);
  const legacyInstalled = installedModelIds.includes(LEGACY_DIARIZER_MODEL_ID);
  return {
    installedModelId: currentInstalled
      ? DIARIZER_MODEL_ID
      : legacyInstalled
        ? LEGACY_DIARIZER_MODEL_ID
        : null,
    needsUpdate: legacyInstalled && !currentInstalled,
  };
}
