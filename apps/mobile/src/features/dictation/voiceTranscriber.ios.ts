import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

import { getLocalVoiceTranscriber as getSystemVoiceTranscriber } from "../../native/voiceTranscription";
import { deviceCanRun, LOCAL_DICTATION_MODELS } from "./dictationModels";
import { dictationNative } from "./dictationNative";
import { makeDictationTranscriber } from "./dictationRuntime";

/**
 * The fork's dictation in place of the system recognizer alone. Voice input stays unavailable only
 * where neither can run: no system recognizer and too little memory for any model.
 */
export async function getLocalVoiceTranscriber(): Promise<VoiceTranscriber | null> {
  if (dictationNative === null) return getSystemVoiceTranscriber();
  const memory = dictationNative.deviceInfo().physicalMemoryBytes;
  if (!LOCAL_DICTATION_MODELS.some((model) => deviceCanRun(model, memory))) {
    const system = await getSystemVoiceTranscriber();
    if (system === null) return null;
  }
  return makeDictationTranscriber(getSystemVoiceTranscriber);
}
