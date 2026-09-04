import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  useAudioRecorder,
  type RecordingStatus,
} from "expo-audio";
import { File } from "expo-file-system";
import { useFocusEffect } from "@react-navigation/native";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState } from "react-native";
import { useSharedValue } from "react-native-reanimated";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { evictResidentModels } from "../../native/t3Voice";
import { getLocalVoiceCleanup } from "../../native/voiceCleanup";
import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import { getNativeShowcaseScene } from "../showcase/nativeShowcaseScene";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  resolveRecoverableTranscript,
  resolveVoiceCleanupSettings,
  resolveVoiceTranscriptionSettings,
} from "./voiceCleanupSettings";
import {
  VoiceInputController,
  VOICE_RECORDING_LIMIT_SECONDS,
  addLearnedCorrections,
  diffCorrections,
  resolveEditedSpan,
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type DictationAnchor,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { normalizeVoiceInputDecibels, VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

/**
 * When this process started reading preferences.
 *
 * Only a record written before this moment came from a session that died. One
 * written after it belongs to a dictation still running.
 */
const SESSION_STARTED_AT = Date.now();

const INITIAL_STATE: VoiceInputState = {
  phase: "idle",
  error: null,
  errorAction: null,
  notice: null,
};
const VOICE_METERING_INTERVAL_MS = 80;
const VOICE_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
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

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  readonly draftMessage: string;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const [state, setState] = useState<VoiceInputState>(INITIAL_STATE);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  const cleanupSettings = useMemo(
    () => (preferences ? resolveVoiceCleanupSettings(preferences) : null),
    [preferences],
  );
  const cleanupSettingsRef = useRef(cleanupSettings);
  cleanupSettingsRef.current = cleanupSettings;
  const transcriptionSettings = useMemo(
    () => (preferences ? resolveVoiceTranscriptionSettings(preferences) : null),
    [preferences],
  );
  const transcriptionSettingsRef = useRef(transcriptionSettings);
  transcriptionSettingsRef.current = transcriptionSettings;
  const savePreferencesRef = useRef(savePreferences);
  savePreferencesRef.current = savePreferences;
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const elapsedSecondsRef = useRef(0);
  const audioLevelsRef = useRef(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0));
  const audioLevels = useSharedValue(audioLevelsRef.current);
  const controllerRef = useRef<VoiceInputController | null>(null);
  const previousDraftRef = useRef({ ownerKey: input.ownerKey, text: input.draftMessage });
  const revisionRef = useRef(0);
  if (
    previousDraftRef.current.ownerKey !== input.ownerKey ||
    previousDraftRef.current.text !== input.draftMessage
  ) {
    previousDraftRef.current = { ownerKey: input.ownerKey, text: input.draftMessage };
    revisionRef.current += 1;
  }
  const latestInputRef = useRef(input);
  latestInputRef.current = input;

  const anchorRef = useRef<DictationAnchor | null>(null);

  const handleRecorderStatus = useCallback((status: RecordingStatus) => {
    controllerRef.current?.handleRecorderStatus({
      isFinished: status.isFinished,
      hasError: status.hasError || status.mediaServicesDidReset === true,
      error: status.error,
      url: status.url,
    });
  }, []);
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS, handleRecorderStatus);

  if (!controllerRef.current) {
    controllerRef.current = new VoiceInputController({
      recorder,
      getTranscriber: () => {
        const settings = transcriptionSettingsRef.current;
        return settings ? getLocalVoiceTranscriber(settings) : null;
      },
      requestPermission: async () => {
        const permission = await requestRecordingPermissionsAsync();
        return { granted: permission.granted, canAskAgain: permission.canAskAgain };
      },
      configureRecording: configureVoiceRecordingAudio,
      releaseRecording: releaseVoiceRecordingAudio,
      deleteRecording: (uri) => new File(uri).delete(),
      readDraft: (): VoiceDraftSnapshot | null => {
        const current = latestInputRef.current;
        if (!current.ownerKey) return null;
        return {
          ownerKey: current.ownerKey,
          text: current.draftMessage,
          selection: current.selection,
          revision: revisionRef.current,
        };
      },
      commitDraft: (text, selection) => {
        const current = latestInputRef.current;
        current.onChangeSelection(selection);
        current.onChangeDraftMessage(text);
      },
      onStateChange: setState,
      getCleanup: () => {
        const settings = cleanupSettingsRef.current;
        return settings ? getLocalVoiceCleanup(settings) : null;
      },
      persistPendingTranscript: (pending) => {
        // Stamped here, not in the controller: the timestamp exists only so a
        // later launch can tell this record from one a dead session left behind.
        savePreferencesRef.current({
          voicePendingTranscript: { ...pending, capturedAt: Date.now() },
        });
      },
      clearPendingTranscript: () => {
        savePreferencesRef.current({ voicePendingTranscript: undefined });
      },
      onDictationCommitted: (anchor) => {
        // One anchor at a time. A second dictation in the same draft replaces
        // the first, because the span the first one wrote is no longer
        // separable from what came after it.
        anchorRef.current = anchor;
      },
    });
  }

  const controller = controllerRef.current;
  const previousOwnerRef = useRef(input.ownerKey);
  useEffect(() => {
    if (previousOwnerRef.current === input.ownerKey) return;
    previousOwnerRef.current = input.ownerKey;
    // The span belonged to the draft that just went away.
    anchorRef.current = null;
    controller.ownerChanged();
  }, [controller, input.ownerKey]);

  useFocusEffect(
    useCallback(
      () => () => {
        controller.dispose();
      },
      [controller],
    ),
  );

  // Models stay resident so the next dictation starts instantly, which means
  // this process is holding several hundred megabytes it does not need right
  // now. A warning costs one slower dictation; ignoring it costs the app.
  useEffect(() => {
    const subscription = AppState.addEventListener("memoryWarning", () => {
      void evictResidentModels();
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      // iOS reports `inactive` while its permission dialog is open. Only the
      // real background state cancels preparation; recorder status handles
      // calls and route interruptions during capture.
      if (nextState === "background") controller.appMovedToBackground();
    });
    return () => subscription.remove();
  }, [controller]);

  useEffect(() => () => controller.dispose(), [controller]);

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
      if (!status.isRecording) return;

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

  const start = useCallback(() => {
    if (!latestInputRef.current.disabled) void controller.start();
  }, [controller]);
  const stop = useCallback(() => controller.stop(), [controller]);
  const cancel = useCallback(() => controller.cancel(), [controller]);

  // Cmd+Option+D on a hardware keyboard, so a dictation never needs the screen.
  // Every handler declines when the composer is disabled or a dictation is
  // already past recording, which lets another screen take the key.
  const shortcut = preferences?.voiceDictationShortcut ?? "hold";

  const canStart = useCallback(() => {
    if (latestInputRef.current.disabled) return false;
    const { phase } = controller.currentState;
    return phase === "idle" || phase === "error";
  }, [controller]);

  const toggleDictation = useCallback(() => {
    if (latestInputRef.current.disabled) return false;
    if (controller.currentState.phase === "recording") {
      void controller.stop();
      return true;
    }
    if (!canStart()) return false;
    void controller.start();
    return true;
  }, [canStart, controller]);

  const startHold = useCallback(() => {
    if (!canStart()) return false;
    void controller.start();
    return true;
  }, [canStart, controller]);

  // Releasing the keys ends the recording. Holding through a phase that is not
  // recording is not an error; there is simply nothing to stop.
  const endHold = useCallback(() => {
    if (controller.currentState.phase !== "recording") return false;
    void controller.stop();
    return true;
  }, [controller]);

  useHardwareKeyboardCommand("toggleDictation", toggleDictation, shortcut === "toggle");
  useHardwareKeyboardCommand("dictationHoldStart", startHold, shortcut === "hold");
  useHardwareKeyboardCommand("dictationHoldEnd", endHold, shortcut === "hold");

  const recoverableTranscript = preferences
    ? resolveRecoverableTranscript(
        preferences,
        { ownerKey: input.ownerKey, text: input.draftMessage },
        SESSION_STARTED_AT,
      )
    : null;

  const discardRecoverableTranscript = useCallback(() => {
    savePreferencesRef.current({ voicePendingTranscript: undefined });
  }, []);

  const insertRecoverableTranscript = useCallback(() => {
    if (!recoverableTranscript) return;
    const current = latestInputRef.current;
    const insertion = current.draftMessage
      ? `${current.draftMessage.trimEnd()} ${recoverableTranscript}`
      : recoverableTranscript;
    current.onChangeDraftMessage(insertion);
    current.onChangeSelection({ start: insertion.length, end: insertion.length });
    savePreferencesRef.current({ voicePendingTranscript: undefined });
  }, [recoverableTranscript]);

  // Offered once, when the composer that owns the transcript appears. Only a
  // process that died between transcription and cleanup leaves one behind, so
  // this is rare enough to interrupt for and too valuable to drop silently.
  const offeredRecoveryRef = useRef(false);
  useEffect(() => {
    if (!recoverableTranscript || offeredRecoveryRef.current) return;
    offeredRecoveryRef.current = true;
    Alert.alert(
      "Add what you said?",
      `T3 Code closed before this was added to the draft.\n\n"${recoverableTranscript}"`,
      [
        { text: "Discard", style: "destructive", onPress: discardRecoverableTranscript },
        { text: "Add", onPress: insertRecoverableTranscript },
      ],
    );
  }, [discardRecoverableTranscript, insertRecoverableTranscript, recoverableTranscript]);

  /**
   * Learns from what the user changed in the words this dictation inserted.
   *
   * Called once, when the draft is sent, because that is the moment the user
   * has stopped editing and every remaining difference is deliberate. Only the
   * dictated span is compared: diffing the whole draft would learn unrelated
   * typing and then apply it to every future transcript.
   */
  const learnFromSubmission = useCallback(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (!anchor) return;

    const current = latestInputRef.current;
    if (anchor.ownerKey !== current.ownerKey) return;

    const edited = resolveEditedSpan(anchor, current.draftMessage);
    if (edited === null) return;

    const learned = diffCorrections(anchor.insertedText, edited);
    if (learned.length === 0) return;

    savePreferencesRef.current({
      voiceLearnedCorrections: addLearnedCorrections(
        preferencesRef.current?.voiceLearnedCorrections ?? [],
        learned,
      ),
    });
  }, []);

  return {
    // Store screenshots show the dictation button even on simulators, whose
    // on-device transcription is unavailable.
    isAvailable:
      (transcriptionSettings !== null &&
        getLocalVoiceTranscriber(transcriptionSettings) !== null) ||
      getNativeShowcaseScene() !== null,
    cleanupEnabled: cleanupSettings?.enabled ?? false,
    /**
     * A transcript from a session that died before it could be committed.
     * Non-null means the composer should offer it back rather than losing it.
     */
    recoverableTranscript,
    insertRecoverableTranscript,
    discardRecoverableTranscript,
    learnFromSubmission,
    state,
    audioLevels,
    elapsedSeconds,
    isBusy: voiceInputBlocksSubmission(state),
    freezesEditor: voiceInputFreezesEditor(state),
    blocksSubmission: voiceInputBlocksSubmission(state),
    start,
    stop,
    cancel,
  };
}
