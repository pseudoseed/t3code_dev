import {
  CLEANUP_TIMEOUT_MS,
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceCleanup,
  type VoiceCleanup,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

import {
  cancelOperation,
  cleanupWithModel,
  getInstalledModelIds,
  prepareCleanupModel,
} from "./t3Voice";
import type { LocalVoiceCleanupSettings } from "./voiceCleanup";

export type { LocalVoiceCleanupSettings } from "./voiceCleanup";

let nextOperationId = 0;

function createOperationId(): string {
  nextOperationId += 1;
  return `cleanup-${nextOperationId}`;
}

/**
 * Asks native to stop, then keeps awaiting the same promise.
 *
 * Generation stops at the next token boundary rather than instantly, and the
 * shared contract is that a cancelled operation settles only once the native
 * work has actually stopped, so racing the promise would be a lie.
 */
function withCancellation<T>(
  operationId: string,
  signal: AbortSignal,
  work: Promise<T>,
): Promise<T> {
  const onAbort = () => {
    void cancelOperation(operationId);
  };

  if (signal.aborted) onAbort();
  signal.addEventListener("abort", onAbort, { once: true });

  return work.finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

/**
 * Transcript cleanup running on a language model on this device.
 *
 * Returns null when cleanup is switched off, no model is selected, or the
 * selected model is not installed. The controller treats all three the same
 * way: it commits the raw transcript and never mentions cleanup.
 */
export function getLocalVoiceCleanup(settings: LocalVoiceCleanupSettings): VoiceCleanup | null {
  const { enabled, modelId, systemPrompt } = settings;
  if (!enabled || !modelId) return null;
  if (!getInstalledModelIds().includes(modelId)) return null;

  return {
    prepare: async ({ signal }: VoiceTranscriptionOptions): Promise<PreparedVoiceCleanup> => {
      throwIfVoiceTranscriptionAborted(signal);

      const operationId = createOperationId();
      try {
        await withCancellation(operationId, signal, prepareCleanupModel(operationId, modelId));
      } catch (error) {
        throw new VoiceTranscriptionError(
          "preparation-failed",
          "The cleanup model could not be loaded.",
          { cause: error },
        );
      }

      return {
        clean: async (transcript, options) => {
          throwIfVoiceTranscriptionAborted(options.signal);

          const cleanupId = createOperationId();
          return withCancellation(
            cleanupId,
            options.signal,
            cleanupWithModel(cleanupId, transcript, systemPrompt, CLEANUP_TIMEOUT_MS),
          );
        },
      };
    },
  };
}
