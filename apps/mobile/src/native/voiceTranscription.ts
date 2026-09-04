import type { VoiceModelEnvironment, VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

export type LocalVoiceTranscriptionSettings = {
  /** Null means "whatever this device should use", resolved per launch. */
  readonly speechModelId: string | null;
  readonly speakerFiltering: boolean;
};

export function getLocalVoiceTranscriber(
  _settings: LocalVoiceTranscriptionSettings,
): VoiceTranscriber | null {
  return null;
}

export function readVoiceModelEnvironmentForApp(): VoiceModelEnvironment | null {
  return null;
}
