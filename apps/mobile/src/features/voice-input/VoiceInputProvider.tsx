import { RegistryContext, useAtomMount, useAtomSet } from "@effect/atom-react";
import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type RecorderState,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import { AsyncResult } from "effect/reactivity";
import { useSharedValue } from "react-native-reanimated";

import {
  microphoneOrder,
  preferredMicrophoneInput,
  rememberMicrophones,
} from "../../lib/microphonePriority";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { getLocalVoiceCleanup } from "../../native/voiceCleanup";
import { evictResidentModels } from "../../native/t3Voice";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import {
  resolveVoiceCleanupSettings,
  resolveVoiceTranscriptionSettings,
} from "./voiceCleanupSettings";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  voiceInputBlocksSubmission,
  addLearnedCorrections,
  diffCorrections,
  resolveEditedSpan,
  type DictationAnchor,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { createLazyVoiceRecorder, type LazyVoiceRecorder } from "./lazyVoiceRecorder";
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";
import { VoiceInputSession } from "./voiceInputSession";

const INITIAL_STATE: VoiceInputState = {
  phase: "idle",
  error: null,
  errorAction: null,
  notice: null,
};
// Only recovery records from a previous process should be offered back to a draft.
export const VOICE_SESSION_STARTED_AT = Date.now();
const VOICE_METERING_INTERVAL_MS = 80;
// The native constructor takes platform-flattened options, as `useAudioRecorder`
// builds them with expo-audio's internal `createRecordingOptions`.
const { ios: IOS_RECORDING_OPTIONS, android: ANDROID_RECORDING_OPTIONS } =
  RecordingPresets.HIGH_QUALITY;
const VOICE_RECORDING_OPTIONS = {
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
  bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
  isMeteringEnabled: true,
  ...(Platform.OS === "ios" ? IOS_RECORDING_OPTIONS : ANDROID_RECORDING_OPTIONS),
};

async function releaseVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({ allowsRecording: false });
  } finally {
    // Expo does not deactivate AVAudioSession when recording stops or its
    // category changes. Explicit deactivation resumes interrupted app audio.
    await setIsAudioActiveAsync(false);
  }
}

async function configureVoiceRecordingAudio(): Promise<void> {
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    await setIsAudioActiveAsync(true);
  } catch (error) {
    try {
      await releaseVoiceRecordingAudio();
    } catch {
      // Keep the setup error. The controller has not started a recorder yet.
    }
    throw error;
  }
}

const VoiceInputContext = createContext<ReturnType<typeof useVoiceInputRuntime> | null>(null);

export function VoiceInputProvider({ children }: { readonly children: ReactNode }) {
  const runtime = useVoiceInputRuntime();
  return <VoiceInputContext value={runtime}>{children}</VoiceInputContext>;
}

export function useGlobalVoiceInput() {
  const context = use(VoiceInputContext);
  if (!context) throw new Error("Voice input provider is missing.");
  return context;
}

function useVoiceInputRuntime() {
  const registry = use(RegistryContext);
  // Dictation reads and records microphones without subscribing the provider to preferences.
  useAtomMount(mobilePreferencesAtom);
  useAtomMount(updateMobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const persistPreferences = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const savePreferencesRef = useRef(savePreferences);
  savePreferencesRef.current = savePreferences;
  const persistPreferencesRef = useRef(persistPreferences);
  persistPreferencesRef.current = persistPreferences;
  const anchorRef = useRef<DictationAnchor | null>(null);
  const [{ state, ownerKey, label }, setState] = useState({
    state: INITIAL_STATE,
    ownerKey: null as string | null,
    label: null as string | null,
  });
  const [focusedOwners, setFocusedOwners] = useState<ReadonlySet<string>>(new Set());
  const setOwnerFocused = useCallback((key: string, focused: boolean) => {
    setFocusedOwners((current) => {
      const next = new Set(current);
      if (focused) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const keepAwakeId = useId();
  const keepAwakeSessionRef = useRef(0);
  const elapsedSecondsRef = useRef(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(audioLevelsRef.current);
  const sessionRef = useRef<VoiceInputSession | null>(null);
  const recorderRef = useRef<LazyVoiceRecorder<RecorderState> | null>(null);

  if (!sessionRef.current || !recorderRef.current) {
    // The native recorder is created when dictation starts, not on app launch.
    const recorder = createLazyVoiceRecorder({
      create: () => new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS),
      onStatus: (status: RecordingStatus) => {
        sessionRef.current?.controller.handleRecorderStatus({
          isFinished: status.isFinished,
          hasError: status.hasError || status.mediaServicesDidReset === true,
          error: status.error,
          url: status.url,
        });
      },
      // Read when recording starts so preference changes do not re-render every composer.
      selectInput: (inputs) => {
        const preferences = registry.get(mobilePreferencesAtom);
        if (!AsyncResult.isSuccess(preferences)) return null;
        const known = microphoneOrder(preferences.value.microphones);
        const order = rememberMicrophones(known, inputs);
        if (order !== known) {
          registry.set(updateMobilePreferencesAtom, {
            transform: (current) => ({
              microphones: rememberMicrophones(microphoneOrder(current.microphones), inputs),
            }),
          });
        }
        return preferredMicrophoneInput(inputs, order);
      },
    });
    recorderRef.current = recorder;
    sessionRef.current = new VoiceInputSession({
      recorder,
      getTranscriber: () => {
        const result = registry.get(mobilePreferencesAtom);
        const settings = AsyncResult.isSuccess(result) ? result.value : null;
        return settings
          ? getLocalVoiceTranscriber(resolveVoiceTranscriptionSettings(settings))
          : null;
      },
      getCleanup: () => {
        const result = registry.get(mobilePreferencesAtom);
        const settings = AsyncResult.isSuccess(result) ? result.value : null;
        return settings ? getLocalVoiceCleanup(resolveVoiceCleanupSettings(settings)) : null;
      },
      persistPendingTranscript: async (pending) => {
        await persistPreferencesRef.current({
          voicePendingTranscript: { ...pending, capturedAt: Date.now() },
        });
      },
      clearPendingTranscript: () =>
        savePreferencesRef.current({ voicePendingTranscript: undefined }),
      onDictationCommitted: (anchor) => {
        anchorRef.current = anchor;
      },
      requestPermission: async () => {
        const permission = await requestRecordingPermissionsAsync();
        return { granted: permission.granted, canAskAgain: permission.canAskAgain };
      },
      configureRecording: configureVoiceRecordingAudio,
      releaseRecording: releaseVoiceRecordingAudio,
      deleteRecording: (uri) => new File(uri).delete(),
      onStateChange: (nextState) =>
        setState({
          state: nextState,
          ownerKey: sessionRef.current?.ownerKey ?? null,
          label: sessionRef.current?.label ?? null,
        }),
    });
  }

  const session = sessionRef.current;
  const controller = session.controller;
  const recorder = recorderRef.current;

  // Feedback outlives the dictation, including when its composer is off screen.
  useEffect(() => {
    if (state.phase !== "idle" || !state.notice) return;
    const timeout = setTimeout(() => {
      if (controller.currentState === state) controller.cancel();
    }, 8_000);
    return () => clearTimeout(timeout);
  }, [controller, state]);

  useEffect(() => {
    const subscription = AppState.addEventListener("memoryWarning", () => {
      void evictResidentModels();
    });
    return () => subscription.remove();
  }, []);

  const learnFromSubmission = useCallback(
    (ownerKey: string | null, text: string) => {
      if (session.ownerKey === ownerKey && controller.currentState.phase === "idle") {
        controller.cancel();
      }
      const anchor = anchorRef.current;
      if (!anchor || anchor.ownerKey !== ownerKey) return;
      anchorRef.current = null;
      const edited = resolveEditedSpan(anchor, text);
      if (edited === null) return;
      const learned = diffCorrections(anchor.insertedText, edited);
      if (learned.length === 0) return;
      savePreferencesRef.current({
        transform: (current) => ({
          voiceLearnedCorrections: addLearnedCorrections(
            current.voiceLearnedCorrections ?? [],
            learned,
          ),
        }),
      });
    },
    [controller, session],
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // iOS reports `inactive` while its permission dialog is open. Only the
      // real background state cancels preparation; recorder status handles
      // calls and route interruptions during capture.
      if (nextState === "background") controller.appMovedToBackground();
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(
    () => () => {
      // Dispose first so an active recording is stopped before the recorder is released.
      controller.dispose();
      recorder.release();
    },
    [controller, recorder],
  );

  useEffect(() => {
    if (state.phase !== "recording") return;

    const tag = `voice-input:${keepAwakeId}:${++keepAwakeSessionRef.current}`;
    const activation = activateKeepAwakeAsync(tag);
    void activation.catch(() => {});
    return () => {
      // Release after activation settles, even if the recording ends immediately.
      void activation.then(() => deactivateKeepAwake(tag)).catch(() => {});
    };
  }, [keepAwakeId, state.phase]);

  useEffect(() => {
    if (state.phase !== "preparing" && state.phase !== "recording") return;

    if (audioLevelsRef.current.some((level) => level !== 0)) {
      audioLevelsRef.current = Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0);
      audioLevels.value = audioLevelsRef.current;
    }
    if (elapsedSecondsRef.current !== 0) {
      elapsedSecondsRef.current = 0;
      setElapsedSeconds(0);
    }
    if (state.phase !== "recording") return;

    const sampleRecording = () => {
      if (controller.currentState.phase !== "recording") return;
      const status = recorder.getStatus();
      if (status) void controller.handleRecordingProgress(status);
      if (!status?.isRecording) return;

      const level = normalizeVoiceInputDecibels(status.metering);
      const history = audioLevelsRef.current;
      if (level !== 0 || history.some((sample) => sample !== 0)) {
        const nextLevels = [...history.slice(1), level];
        audioLevelsRef.current = nextLevels;
        audioLevels.value = nextLevels;
      }

      const nextElapsedSeconds = Math.min(
        VOICE_RECORDING_LIMIT_SECONDS,
        Math.max(0, Math.floor(status.durationMillis / 1_000)),
      );
      if (nextElapsedSeconds !== elapsedSecondsRef.current) {
        elapsedSecondsRef.current = nextElapsedSeconds;
        setElapsedSeconds(nextElapsedSeconds);
      }
    };

    sampleRecording();
    const intervalId = setInterval(sampleRecording, VOICE_METERING_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [audioLevels, controller, recorder, state.phase]);

  const stop = useCallback(() => controller.stop(), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);

  const preferences = registry.get(mobilePreferencesAtom);
  return {
    isAvailable:
      (AsyncResult.isSuccess(preferences) &&
        getLocalVoiceTranscriber(resolveVoiceTranscriptionSettings(preferences.value)) !== null) ||
      getNativeShowcaseScene() !== null,
    learnFromSubmission,
    state,
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    ownerKey,
    label,
    focusedOwners,
    setOwnerFocused,
    session,
    stop,
    cancel,
  };
}
