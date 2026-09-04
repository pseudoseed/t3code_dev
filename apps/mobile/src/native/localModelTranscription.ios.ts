import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

import {
  cancelOperation,
  getInstalledModelIds,
  prepareModel,
  transcribeWithModel,
} from "./t3Voice";

let nextOperationId = 0;

function createOperationId(): string {
  nextOperationId += 1;
  return `voice-${nextOperationId}`;
}

/**
 * The native side takes a filesystem path. The recorder hands back a `file://`
 * URI, and percent-escapes anything unusual in the name.
 */
function toFilePath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  return decodeURIComponent(uri.slice("file://".length));
}

/**
 * Bridges one AbortSignal onto the native operation id.
 *
 * The shared contract is that a cancelled operation settles only once the
 * native work has actually stopped, so this asks native to cancel and then
 * keeps awaiting the same promise rather than racing it.
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

function isCancellation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "T3VoiceCancelled"
  );
}

function wrap(
  code: "preparation-failed" | "transcription-failed",
  message: string,
  error: unknown,
): VoiceTranscriptionError {
  if (error instanceof VoiceTranscriptionError) return error;
  if (isCancellation(error)) {
    return new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.", {
      cause: error,
    });
  }

  return new VoiceTranscriptionError(code, message, { cause: error });
}

/**
 * A transcriber backed by a speech model running on this device.
 *
 * One implementation covers every local backend: the native module routes by
 * model id, so WhisperKit and FluidAudio differ only in what they report back
 * about speaker filtering.
 *
 * Returns null when the model is not installed, which is how a caller
 * distinguishes "not downloaded yet" from "this device cannot do it at all".
 */
export function getLocalModelVoiceTranscriber(input: {
  readonly modelId: string;
  readonly locale: string;
  readonly speakerFiltering: boolean;
}): VoiceTranscriber | null {
  const { modelId, locale, speakerFiltering } = input;
  if (!getInstalledModelIds().includes(modelId)) return null;

  return {
    prepare: async ({ signal }: VoiceTranscriptionOptions): Promise<PreparedVoiceTranscription> => {
      throwIfVoiceTranscriptionAborted(signal);

      const operationId = createOperationId();
      try {
        await withCancellation(
          operationId,
          signal,
          prepareModel(operationId, modelId, speakerFiltering),
        );
      } catch (error) {
        throwIfVoiceTranscriptionAborted(signal);
        throw wrap("preparation-failed", "The speech model could not be loaded.", error);
      }

      throwIfVoiceTranscriptionAborted(signal);

      return {
        locale,
        transcribe: async (uri, options) => {
          throwIfVoiceTranscriptionAborted(options.signal);

          const transcribeId = createOperationId();
          try {
            return await withCancellation(
              transcribeId,
              options.signal,
              transcribeWithModel({
                operationId: transcribeId,
                modelId,
                audioPath: toFilePath(uri),
                locale,
                speakerFiltering,
              }),
            );
          } catch (error) {
            throwIfVoiceTranscriptionAborted(options.signal);
            throw wrap("transcription-failed", "Voice transcription failed.", error);
          }
        },
      };
    },
  };
}
