import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import {
  voiceInputBlocksSubmission,
  voiceInputFreezesEditor,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useGlobalVoiceInput, VOICE_SESSION_STARTED_AT } from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { resolveRecoverableTranscript } from "./voiceCleanupSettings";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null, notice: null };

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  /** Shown by the global dictation pill when this composer is off screen. */
  readonly label: string;
  readonly readDraftMessage: () => string | null;
  readonly subscribeToDraftChanges: (onChange: () => void) => () => void;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const global = useGlobalVoiceInput();
  const { setOwnerFocused, session } = global;
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const focused = useRef(false);
  const latestInput = useRef(input);
  latestInput.current = input;
  const recoverableTranscript = preferences
    ? resolveRecoverableTranscript(
        preferences,
        {
          ownerKey: input.ownerKey,
          text: input.readDraftMessage() ?? "",
        },
        VOICE_SESSION_STARTED_AT,
      )
    : null;
  const recoveryPending = useRef(recoverableTranscript !== null);
  recoveryPending.current = recoverableTranscript !== null;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const ownerKey = input.ownerKey;
      if (!ownerKey) return;
      focused.current = true;
      setOwnerFocused(ownerKey, true);
      return () => {
        focused.current = false;
        setOwnerFocused(ownerKey, false);
      };
    }, [input.ownerKey, setOwnerFocused]),
  );

  const start = useCallback(() => {
    const captured = latestInput.current;
    if (!captured.ownerKey || captured.disabled || recoveryPending.current) return;
    void session.start({
      ...createVoiceInputTarget(
        captured.ownerKey,
        captured.readDraftMessage,
        (text, selection) => {
          captured.onChangeDraftMessage(text);
          if (mounted.current && latestInput.current.ownerKey === captured.ownerKey) {
            latestInput.current.onChangeSelection(selection);
          }
        },
        captured.selection,
        captured.subscribeToDraftChanges,
      ),
      label: captured.label,
    });
  }, [session]);

  const startFromKeyboard = useCallback(() => {
    if (
      !focused.current ||
      latestInput.current.disabled ||
      !latestInput.current.ownerKey ||
      recoveryPending.current
    )
      return false;
    if (voiceInputBlocksSubmission(session.controller.currentState)) return false;
    start();
    return true;
  }, [session, start]);
  const endHold = useCallback(() => {
    if (session.ownerKey !== latestInput.current.ownerKey) return false;
    const phase = session.controller.currentState.phase;
    if (phase !== "preparing" && phase !== "recording") return false;
    void session.controller.stop();
    return true;
  }, [session]);
  const toggleDictation = useCallback(
    () => endHold() || startFromKeyboard(),
    [endHold, startFromKeyboard],
  );
  const shortcut = preferences?.voiceDictationShortcut ?? "hold";
  useHardwareKeyboardCommand("toggleDictation", toggleDictation, shortcut === "toggle");
  useHardwareKeyboardCommand("dictationHoldStart", startFromKeyboard, shortcut === "hold");
  useHardwareKeyboardCommand("dictationHoldEnd", endHold, shortcut === "hold");

  const discardRecoverableTranscript = useCallback(() => {
    savePreferences({ voicePendingTranscript: undefined });
  }, [savePreferences]);
  const insertRecoverableTranscript = useCallback(() => {
    if (!recoverableTranscript) return;
    const current = latestInput.current;
    const draft = current.readDraftMessage();
    if (draft === null) return;
    const insertion = draft ? `${draft.trimEnd()} ${recoverableTranscript}` : recoverableTranscript;
    current.onChangeDraftMessage(insertion);
    current.onChangeSelection({ start: insertion.length, end: insertion.length });
    discardRecoverableTranscript();
  }, [discardRecoverableTranscript, recoverableTranscript]);
  const learnFromSubmission = useCallback(() => {
    const current = latestInput.current;
    const text = current.readDraftMessage();
    if (text !== null) global.learnFromSubmission(current.ownerKey, text);
  }, [global.learnFromSubmission]);
  const state = global.ownerKey === input.ownerKey ? global.state : IDLE_STATE;
  const isBusy = voiceInputBlocksSubmission(state);
  return {
    isAvailable: global.isAvailable && (!global.isBusy || global.ownerKey === input.ownerKey),
    cleanupEnabled: global.cleanupEnabled,
    recoverableTranscript,
    insertRecoverableTranscript,
    discardRecoverableTranscript,
    learnFromSubmission,
    state,
    audioLevels: global.audioLevels,
    elapsedSeconds: global.elapsedSeconds,
    isBusy,
    freezesEditor: voiceInputFreezesEditor(state),
    blocksSubmission: isBusy,
    start,
    stop: global.stop,
    cancel: global.cancel,
  };
}
