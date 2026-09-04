import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";

export type VoiceComposerPresentation = {
  readonly leadingAction: "cancel" | null;
  readonly trailingAction: "mic" | "confirm";
  readonly showsSend: boolean;
  readonly statusKind: "active" | "error" | "notice" | null;
  readonly statusLabel: string | null;
  readonly confirmationEnabled: boolean;
};

export function resolveVoiceComposerPresentation(
  state: VoiceInputState,
  elapsedSeconds: number,
): VoiceComposerPresentation {
  switch (state.phase) {
    case "idle":
      // A notice outlives the dictation that produced it, because idle is the
      // only moment the user is reading the composer rather than watching it.
      return {
        leadingAction: null,
        trailingAction: "mic",
        showsSend: true,
        statusKind: state.notice ? "notice" : null,
        statusLabel: state.notice,
        confirmationEnabled: false,
      };
    case "error":
      return {
        leadingAction: null,
        trailingAction: "mic",
        showsSend: true,
        statusKind: "error",
        statusLabel: state.error,
        confirmationEnabled: false,
      };
    case "preparing":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: "Preparing",
        confirmationEnabled: false,
      };
    case "recording": {
      const seconds = Math.max(0, Math.floor(elapsedSeconds));
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
        confirmationEnabled: true,
      };
    }
    case "waitingForModel":
      // Named for what it is. A transcription spinner over a model that has not
      // loaded is the lying spinner this whole state exists to avoid.
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: "Loading speech model",
        confirmationEnabled: false,
      };
    case "transcribing":
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: "Transcribing",
        confirmationEnabled: false,
      };
    case "cleaning":
      // Cancelling here skips the rewrite and keeps the raw transcript, so the
      // cancel affordance stays available rather than locking the user out of a
      // stage that can take several seconds on a local model.
      return {
        leadingAction: "cancel",
        trailingAction: "confirm",
        showsSend: false,
        statusKind: "active",
        statusLabel: "Cleaning up",
        confirmationEnabled: false,
      };
  }
}
