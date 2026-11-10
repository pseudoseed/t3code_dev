import { AudioModule, RecordingPresets, requestRecordingPermissionsAsync } from "expo-audio";

import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";
import { ENROLLMENT_CLIP_LIMIT_SECONDS, type EnrollmentRecording } from "./voiceEnrollment";

// The native constructor expects platform-flattened options, as built by useAudioRecorder.
const RECORDING_OPTIONS = {
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
  bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
  ...RecordingPresets.HIGH_QUALITY.ios,
};

/** Records one voice sample with the microphone the system has selected. */
export async function recordEnrollmentClip(onLimit: () => void): Promise<EnrollmentRecording> {
  const permission = await requestRecordingPermissionsAsync().catch(() => null);
  if (permission?.granted !== true) {
    throw new Error("Microphone access is off for PseudoCode. Turn it on in Settings.");
  }
  // Another recording or a player taking the audio session ends this sample where it is.
  const token = acquireAudioSession("recording", onLimit);
  let recorder: InstanceType<typeof AudioModule.AudioRecorder> | null = null;
  try {
    await activateAudioSession(token);
    recorder = new AudioModule.AudioRecorder(RECORDING_OPTIONS);
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: ENROLLMENT_CLIP_LIMIT_SECONDS });
  } catch (cause) {
    recorder?.release();
    await releaseAudioSession(token).catch(() => {});
    throw new Error("Recording could not start.", { cause });
  }
  const active = recorder;
  const subscription = active.addListener("recordingStatusUpdate", (status) => {
    if (status.isFinished) onLimit();
  });
  return {
    async stop() {
      subscription.remove();
      try {
        await active.stop();
        return active.uri;
      } finally {
        active.release();
        await releaseAudioSession(token).catch(() => {});
      }
    },
  };
}
