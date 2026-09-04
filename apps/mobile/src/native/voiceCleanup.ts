import type { VoiceCleanup } from "@t3tools/client-runtime/voice-input";

export type LocalVoiceCleanupSettings = {
  readonly enabled: boolean;
  readonly modelId: string | null;
  readonly systemPrompt: string;
};

export function getLocalVoiceCleanup(_settings: LocalVoiceCleanupSettings): VoiceCleanup | null {
  return null;
}
