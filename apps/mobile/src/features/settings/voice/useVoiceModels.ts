import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Network from "expo-network";

import {
  DIARIZER_DOWNLOAD_BYTES,
  DIARIZER_MODEL_ID,
  cancelOperation,
  deleteModel,
  downloadModel,
  getInstalledModelIds,
  getStorageUsageBytes,
  isManagedDownload,
  onModelDownloadProgress,
} from "../../../native/t3Voice";
import { readVoiceModelEnvironmentForApp } from "../../../native/voiceTranscription";
import type { VoiceModelsSnapshot } from "./voiceSettings";

let nextDownloadId = 0;

/**
 * Owns what is installed, what is downloading, and what went wrong.
 *
 * Installed state is re-read after every action rather than tracked, because
 * the native store is the only thing that knows whether a download actually
 * finished, and a mirror of it here would drift the first time one failed.
 */
export function useVoiceModels(input: {
  readonly selectedSpeechModelId: string | null;
  readonly selectedCleanupModelId: string | null;
  readonly allowsCellular: boolean;
}) {
  const [installedModelIds, setInstalledModelIds] = useState<readonly string[]>(() =>
    getInstalledModelIds(),
  );
  const [storageBytes, setStorageBytes] = useState(() => getStorageUsageBytes());
  const [download, setDownload] = useState<VoiceModelsSnapshot["download"]>(null);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const operationIdRef = useRef<string | null>(null);
  const allowsCellularRef = useRef(input.allowsCellular);
  allowsCellularRef.current = input.allowsCellular;

  // Read once per mount. Memory moves constantly, but a picker whose rows
  // reshuffled while the user was reading them would be worse than one built
  // from a snapshot; the load path checks the real budget again anyway.
  const environment = useMemo(() => readVoiceModelEnvironmentForApp(), []);

  const refresh = useCallback(() => {
    setInstalledModelIds(getInstalledModelIds());
    setStorageBytes(getStorageUsageBytes());
  }, []);

  useEffect(
    () =>
      onModelDownloadProgress((progress) => {
        setDownload((current) =>
          current?.modelId === progress.modelId
            ? {
                modelId: progress.modelId,
                fraction:
                  progress.totalBytes > 0 ? progress.completedBytes / progress.totalBytes : null,
              }
            : current,
        );
      }),
    [],
  );

  const startDownload = useCallback(
    async (modelId: string) => {
      if (operationIdRef.current) return;

      if (!allowsCellularRef.current) {
        const state = await Network.getNetworkStateAsync();
        if (state.type === Network.NetworkStateType.CELLULAR) {
          setFailures((current) => ({
            ...current,
            [modelId]: "Waiting for Wi-Fi. Turn on cellular downloads to start now.",
          }));
          return;
        }
      }

      nextDownloadId += 1;
      const operationId = `voice-download-${nextDownloadId}`;
      operationIdRef.current = operationId;
      setFailures((current) => {
        const next = { ...current };
        delete next[modelId];
        return next;
      });
      // Managed downloads report no progress, so they start at unknown rather
      // than at zero. A bar that sits at 0% for four minutes reads as broken.
      setDownload({ modelId, fraction: isManagedDownload(modelId) ? null : 0 });

      try {
        await downloadModel(operationId, modelId, {
          allowsCellular: allowsCellularRef.current,
        });
      } catch (error) {
        setFailures((current) => ({ ...current, [modelId]: describeDownloadError(error) }));
      } finally {
        operationIdRef.current = null;
        setDownload(null);
        refresh();
      }
    },
    [refresh],
  );

  const cancelDownload = useCallback(() => {
    const operationId = operationIdRef.current;
    if (operationId) void cancelOperation(operationId);
  }, []);

  const removeModel = useCallback(
    async (modelId: string) => {
      await deleteModel(modelId);
      setFailures((current) => {
        const next = { ...current };
        delete next[modelId];
        return next;
      });
      refresh();
    },
    [refresh],
  );

  const snapshot: VoiceModelsSnapshot = {
    environment,
    installedModelIds,
    selectedSpeechModelId: input.selectedSpeechModelId,
    selectedCleanupModelId: input.selectedCleanupModelId,
    download,
    failures,
  };

  return {
    snapshot,
    storageBytes,
    diarizerInstalled: installedModelIds.includes(DIARIZER_MODEL_ID),
    diarizerBytes: DIARIZER_DOWNLOAD_BYTES,
    startDownload,
    cancelDownload,
    removeModel,
    refresh,
  };
}

function describeDownloadError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "T3VoiceCancelled") return "Download cancelled.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "The download did not finish. Try again.";
}
