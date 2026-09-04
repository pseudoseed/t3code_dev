import { replaceTextRange } from "@t3tools/shared/composerTrigger";

import { resolveCleanupOutcome, type VoiceCleanup } from "./cleanup.ts";
import type { DictationAnchor } from "./learning.ts";
import {
  resolveSpeakerFilteringNotice,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
} from "./transcription.ts";

export const VOICE_RECORDING_LIMIT_SECONDS = 5 * 60;

export type VoiceInputPhase =
  | "idle"
  | "preparing"
  | "recording"
  | "transcribing"
  | "cleaning"
  | "error";

export type VoiceInputState = {
  readonly phase: VoiceInputPhase;
  readonly error: string | null;
  readonly errorAction: "retry" | "settings" | null;
  /**
   * Something the last dictation did that the user should know about, without
   * it having failed. Survives into `idle` because that is when it is read, and
   * is cleared the moment the next recording starts.
   */
  readonly notice: string | null;
};

export function voiceInputBlocksSubmission(state: VoiceInputState): boolean {
  return (
    state.phase === "preparing" ||
    state.phase === "recording" ||
    state.phase === "transcribing" ||
    state.phase === "cleaning"
  );
}

export function voiceInputFreezesEditor(state: VoiceInputState): boolean {
  return voiceInputBlocksSubmission(state);
}

export type VoiceDraftSnapshot = {
  readonly ownerKey: string;
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly revision: number;
};

/**
 * A transcript written to disk before the cleanup stage runs.
 *
 * Cleanup loads a multi-hundred-megabyte model, and an allocation that gets the
 * app jetsam-killed raises no error to catch. The record survives that, so the
 * next launch can offer back what the user said instead of losing it.
 */
export type PendingVoiceTranscript = {
  readonly ownerKey: string;
  readonly revision: number;
  readonly text: string;
};

export type VoiceRecorderStatus = {
  readonly isFinished: boolean;
  readonly hasError: boolean;
  readonly error: string | null;
  readonly url: string | null;
};

export interface VoiceRecorder {
  readonly uri: string | null;
  prepareToRecordAsync(): Promise<void>;
  record(options: { readonly forDuration: number }): void;
  stop(): Promise<void>;
}

export type VoiceInputControllerDependencies = {
  readonly recorder: VoiceRecorder;
  readonly getTranscriber: () => VoiceTranscriber | null;
  readonly requestPermission: () => Promise<{
    readonly granted: boolean;
    readonly canAskAgain: boolean;
  }>;
  readonly configureRecording: () => Promise<void>;
  readonly releaseRecording: () => Promise<void>;
  readonly deleteRecording: (uri: string) => void;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
  readonly onStateChange: (state: VoiceInputState) => void;
  /** Returns null when cleanup is switched off or has no model loaded. */
  readonly getCleanup?: () => VoiceCleanup | null;
  readonly persistPendingTranscript?: (pending: PendingVoiceTranscript) => void;
  readonly clearPendingTranscript?: () => void;
  /**
   * Called once per committed dictation with the span it wrote, so the learning
   * loop can diff that span alone at submit time.
   */
  readonly onDictationCommitted?: (anchor: DictationAnchor) => void;
};

type TranscriptCommitResult =
  | {
      readonly kind: "commit";
      readonly text: string;
      readonly selection: { readonly start: number; readonly end: number };
      /** Where the transcript landed, so the learning loop can watch that span. */
      readonly insertedRange: { readonly start: number; readonly end: number };
    }
  | { readonly kind: "stale" }
  | { readonly kind: "empty" };

export function resolveTranscriptCommit(
  captured: VoiceDraftSnapshot,
  current: VoiceDraftSnapshot | null,
  transcript: string,
  locale: string,
): TranscriptCommitResult {
  if (
    !current ||
    current.ownerKey !== captured.ownerKey ||
    current.text !== captured.text ||
    current.revision !== captured.revision
  ) {
    return { kind: "stale" };
  }

  const replacement = transcript.trim();
  if (replacement.length === 0) {
    return { kind: "empty" };
  }

  const isEmptySelection = captured.selection.start === captured.selection.end;
  const normalizedLocale = locale.replaceAll("_", "-").toLowerCase();
  const usesEnglishSpacing = normalizedLocale === "en" || normalizedLocale.startsWith("en-");
  let insertion = replacement;
  if (isEmptySelection && usesEnglishSpacing) {
    const left = captured.text[captured.selection.start - 1];
    const right = captured.text[captured.selection.start];
    const leftNeedsBoundary =
      left !== undefined &&
      /[A-Za-z0-9.!?,:;)\]}'"]/.test(left) &&
      (right === undefined || /\s/.test(right));
    const rightNeedsBoundary =
      right !== undefined &&
      /[A-Za-z0-9([{'"]/.test(right) &&
      (left === undefined || /\s/.test(left));
    insertion = `${leftNeedsBoundary ? " " : ""}${replacement}${rightNeedsBoundary ? " " : ""}`;
  }

  const result = replaceTextRange(
    captured.text,
    captured.selection.start,
    captured.selection.end,
    insertion,
  );
  return {
    kind: "commit",
    text: result.text,
    selection: { start: result.cursor, end: result.cursor },
    insertedRange: { start: captured.selection.start, end: result.cursor },
  };
}

let activeSession: symbol | null = null;
let activeTranscriptionOperation: Promise<unknown> | null = null;

function acquireSession(): symbol | null {
  if (activeSession) return null;
  const token = Symbol("voice-input-session");
  activeSession = token;
  return token;
}

function releaseSession(token: symbol | null): void {
  if (token && activeSession === token) activeSession = null;
}

async function runTranscriptionOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (activeTranscriptionOperation) {
    throw new Error("voice-operation-busy");
  }

  const promise = operation();
  activeTranscriptionOperation = promise;
  try {
    return await promise;
  } finally {
    if (activeTranscriptionOperation === promise) activeTranscriptionOperation = null;
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function preparationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "voice-operation-busy") {
    return "Voice transcription is still finishing. Try again shortly.";
  }
  if (errorCode(error) === "unsupported-locale") {
    return "Voice transcription is not available for this language.";
  }
  return "Could not prepare voice transcription.";
}

function transcriptionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "voice-operation-busy") {
    return "Voice transcription is still finishing. Try again shortly.";
  }
  return "Could not transcribe this recording.";
}

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null, notice: null };

export class VoiceInputController {
  private readonly dependencies: VoiceInputControllerDependencies;
  private state: VoiceInputState = IDLE_STATE;
  private operationToken = 0;
  private sessionToken: symbol | null = null;
  private transcription: PreparedVoiceTranscription | null = null;
  private transcriptionAbortController: AbortController | null = null;
  private capturedDraft: VoiceDraftSnapshot | null = null;
  private recordingUri: string | null = null;
  private readonly ownedRecordingUris = new Set<string>();
  private recordingConfigured = false;
  private finishing = false;
  private cleanupAbortController: AbortController | null = null;
  private pendingTranscriptPersisted = false;

  constructor(dependencies: VoiceInputControllerDependencies) {
    this.dependencies = dependencies;
  }

  get currentState(): VoiceInputState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state.phase !== "idle" && this.state.phase !== "error") return;
    const initiatingDraft = this.dependencies.readDraft();
    if (!initiatingDraft) {
      this.setError("This draft is no longer available.", "retry");
      return;
    }
    const sessionToken = acquireSession();
    if (!sessionToken) {
      this.setError("Another voice recording is already active.", "retry");
      return;
    }

    this.sessionToken = sessionToken;
    const operationToken = ++this.operationToken;
    const abortController = new AbortController();
    this.transcriptionAbortController = abortController;
    this.setState({ phase: "preparing", error: null, errorAction: null, notice: null });

    try {
      const transcriber = this.dependencies.getTranscriber();
      if (!transcriber) {
        this.setError("Voice transcription is not available.", null);
        return;
      }

      const permission = await this.dependencies.requestPermission();
      if (!this.isCurrent(operationToken)) return;
      if (!permission.granted) {
        this.setError(
          "Microphone access is required for voice input.",
          permission.canAskAgain ? "retry" : "settings",
        );
        return;
      }

      try {
        this.transcription = await runTranscriptionOperation(() =>
          transcriber.prepare({ signal: abortController.signal }),
        );
      } catch (error) {
        if (this.isCurrent(operationToken)) this.setError(preparationErrorMessage(error), "retry");
        return;
      }
      if (!this.isCurrent(operationToken)) return;

      await this.dependencies.configureRecording();
      this.recordingConfigured = true;
      if (!this.isCurrent(operationToken)) return;
      await this.dependencies.recorder.prepareToRecordAsync();
      if (!this.isCurrent(operationToken)) return;
      this.recordingUri = this.dependencies.recorder.uri;
      this.rememberRecordingUri(this.recordingUri);

      const capturedDraft = this.dependencies.readDraft();
      if (!capturedDraft || capturedDraft.ownerKey !== initiatingDraft.ownerKey) {
        this.setError("This draft is no longer available.", "retry");
        return;
      }
      this.capturedDraft = capturedDraft;
      this.dependencies.recorder.record({ forDuration: VOICE_RECORDING_LIMIT_SECONDS });
      this.setState({ phase: "recording", error: null, errorAction: null, notice: null });
    } catch {
      if (this.isCurrent(operationToken))
        this.setError("Could not start voice recording.", "retry");
    } finally {
      if (this.isCurrent(operationToken) && this.state.phase === "error") {
        await this.releaseResources();
      } else if (!this.isCurrent(operationToken) && !this.finishing) {
        await this.releaseResources();
      }
    }
  }

  stop(): Promise<void> {
    if (this.state.phase !== "recording") return Promise.resolve();
    return this.finishRecording(false, null);
  }

  cancel(): void {
    switch (this.state.phase) {
      case "idle":
        // Nothing to cancel, but the dismiss affordance on a notice routes
        // here, and a notice nobody can clear is a permanent one.
        if (this.state.notice) this.setState(IDLE_STATE);
        return;
      case "error":
        this.setState(IDLE_STATE);
        return;
      case "preparing":
        this.invalidateOperation();
        this.setState(IDLE_STATE);
        return;
      case "recording":
        this.discardRecording(null);
        return;
      case "transcribing":
        this.invalidateOperation();
        this.setState(IDLE_STATE);
        return;
      case "cleaning":
        // Cancelling the rewrite is not cancelling the dictation. The raw
        // transcript is what the user said, so it still gets committed.
        this.cleanupAbortController?.abort();
        return;
    }
  }

  interruptRecording(
    message = "Voice recording was interrupted.",
    completedUri: string | null = null,
  ): Promise<void> | void {
    if (this.state.phase !== "recording") return;
    this.rememberRecordingUri(completedUri);
    this.recordingUri = completedUri ?? this.recordingUri;
    return this.discardRecording(message);
  }

  appMovedToBackground(): Promise<void> | void {
    if (this.state.phase === "preparing") {
      this.invalidateOperation();
      this.setError("Voice input stopped when the app moved to the background.", "retry");
      return;
    }

    // Transcription and cleanup keep running. The implementation holds a
    // background assertion for them, so they finish or stop cleanly; abandoning
    // them here would throw away a recording the user already made.
    if (this.state.phase === "transcribing" || this.state.phase === "cleaning") return;

    return this.interruptRecording();
  }

  handleRecorderStatus(status: VoiceRecorderStatus): Promise<void> | void {
    if (this.state.phase !== "recording") return;
    if (status.hasError) {
      return this.interruptRecording(
        status.error ?? "Voice recording was interrupted.",
        status.url,
      );
    }
    if (status.isFinished) {
      if (!status.url) {
        return this.interruptRecording();
      }
      return this.finishRecording(true, status.url);
    }
  }

  ownerChanged(): void {
    if (this.state.phase === "idle") return;
    if (this.state.phase === "cleaning") {
      // The draft this transcript belongs to is gone, so unlike a user cancel
      // there is nothing left to commit it into.
      this.abandonCleaning();
      return;
    }
    this.cancel();
  }

  dispose(): void {
    if (this.state.phase === "recording") {
      this.discardRecording(null);
      return;
    }
    if (this.state.phase === "cleaning") {
      this.abandonCleaning();
      return;
    }
    if (this.state.phase === "preparing" || this.state.phase === "transcribing") {
      this.invalidateOperation();
      this.setState(IDLE_STATE);
    }
  }

  private abandonCleaning(): void {
    this.invalidateOperation();
    this.cleanupAbortController?.abort();
    this.setState(IDLE_STATE);
  }

  private async finishRecording(
    alreadyStopped: boolean,
    completedUri: string | null,
  ): Promise<void> {
    if (this.finishing || this.state.phase !== "recording") return;
    this.finishing = true;
    const operationToken = this.operationToken;
    this.setState({ phase: "transcribing", error: null, errorAction: null, notice: null });

    try {
      if (!alreadyStopped) await this.dependencies.recorder.stop();
      await this.releaseAudioSession();
      this.recordingUri = completedUri ?? this.dependencies.recorder.uri ?? this.recordingUri;
      this.rememberRecordingUri(this.recordingUri);
      if (!this.isCurrent(operationToken)) return;
      if (
        !this.recordingUri ||
        !this.transcription ||
        !this.transcriptionAbortController ||
        !this.capturedDraft
      ) {
        this.setError("Could not finish voice recording.", "retry");
        return;
      }

      const recordingUri = this.recordingUri;
      const transcription = this.transcription;
      const signal = this.transcriptionAbortController.signal;
      const capturedDraft = this.capturedDraft;
      let transcript: string;
      let notice: string | null = null;
      try {
        const result = await runTranscriptionOperation(() =>
          transcription.transcribe(recordingUri, { signal }),
        );
        transcript = result.text;
        notice = result.notice ?? resolveSpeakerFilteringNotice(result.speakerFiltering);
      } catch (error) {
        if (this.isCurrent(operationToken)) {
          this.setError(transcriptionErrorMessage(error), "retry");
        }
        return;
      }
      if (!this.isCurrent(operationToken)) return;

      const cleanup = this.dependencies.getCleanup?.() ?? null;
      let committedTranscript = transcript;
      if (cleanup && transcript.trim().length > 0) {
        // The store stamps the time it was written. The controller has no
        // clock of its own, and the stamp only matters to the code deciding
        // whether a record outlived the session that made it.
        this.dependencies.persistPendingTranscript?.({
          ownerKey: capturedDraft.ownerKey,
          revision: capturedDraft.revision,
          text: transcript,
        });
        this.pendingTranscriptPersisted = true;
        this.setState({ phase: "cleaning", error: null, errorAction: null, notice: null });
        committedTranscript = await this.runCleanup(cleanup, transcript);
        if (!this.isCurrent(operationToken)) return;
      }

      const result = resolveTranscriptCommit(
        capturedDraft,
        this.dependencies.readDraft(),
        committedTranscript,
        transcription.locale,
      );
      if (result.kind === "stale") {
        this.setError(
          "The draft changed while voice input was running. The transcript was not added.",
          "retry",
        );
        return;
      }
      if (result.kind === "empty") {
        this.setError("No speech was detected.", "retry");
        return;
      }

      this.dependencies.commitDraft(result.text, result.selection);
      this.dependencies.onDictationCommitted?.({
        ownerKey: capturedDraft.ownerKey,
        revision: capturedDraft.revision,
        before: result.text.slice(0, result.insertedRange.start),
        insertedText: result.text.slice(result.insertedRange.start, result.insertedRange.end),
        after: result.text.slice(result.insertedRange.end),
      });
      this.setState({ phase: "idle", error: null, errorAction: null, notice });
    } catch {
      if (this.isCurrent(operationToken)) {
        this.setError("Could not finish voice recording.", "retry");
      }
    } finally {
      this.finishing = false;
      await this.releaseResources();
    }
  }

  /**
   * Runs the cleanup stage, degrading to the raw transcript rather than failing.
   *
   * Every exit lands on text. A throw, a cancel, a timeout, an empty result,
   * and a result whose length says the model answered the transcript instead of
   * rewriting it all commit what the user actually said. Cleanup is an
   * improvement on the transcript; it is never a gate on getting one.
   *
   * The timeout is enforced by the implementation rather than here. Generation
   * stops between tokens, so only the side running it can end a run early; a
   * timer here would abandon the promise while the model kept burning battery.
   */
  private async runCleanup(cleanup: VoiceCleanup, transcript: string): Promise<string> {
    const abortController = new AbortController();
    this.cleanupAbortController = abortController;

    try {
      const cleaned = await runTranscriptionOperation(async () => {
        const prepared = await cleanup.prepare({ signal: abortController.signal });
        return prepared.clean(transcript, { signal: abortController.signal });
      });
      return resolveCleanupOutcome(transcript, cleaned).text;
    } catch {
      return transcript;
    } finally {
      if (this.cleanupAbortController === abortController) this.cleanupAbortController = null;
    }
  }

  private async discardRecording(error: string | null): Promise<void> {
    this.invalidateOperation();
    this.setState(
      error
        ? { phase: "error", error, errorAction: "retry", notice: null }
        : { phase: "idle", error: null, errorAction: null, notice: null },
    );
    try {
      await this.dependencies.recorder.stop();
      this.rememberRecordingUri(this.dependencies.recorder.uri);
    } catch {
      this.rememberRecordingUri(this.dependencies.recorder.uri);
    } finally {
      await this.releaseResources();
    }
  }

  private async releaseResources(): Promise<void> {
    this.rememberRecordingUri(this.recordingUri);
    this.rememberRecordingUri(this.dependencies.recorder.uri);
    this.recordingUri = null;
    for (const uri of this.ownedRecordingUris) {
      try {
        this.dependencies.deleteRecording(uri);
      } catch {
        // The cache may already have removed a failed or interrupted recording.
      }
    }
    this.ownedRecordingUris.clear();
    await this.releaseAudioSession();
    releaseSession(this.sessionToken);
    this.sessionToken = null;
    this.capturedDraft = null;
    this.transcription = null;
    this.transcriptionAbortController = null;
    this.cleanupAbortController = null;
    if (this.pendingTranscriptPersisted) {
      // Reaching here at all means the process outlived cleanup and the user
      // has been told what happened, so the crash-recovery record is spent.
      this.pendingTranscriptPersisted = false;
      this.dependencies.clearPendingTranscript?.();
    }
  }

  private rememberRecordingUri(uri: string | null): void {
    if (uri) this.ownedRecordingUris.add(uri);
  }

  private async releaseAudioSession(): Promise<void> {
    if (!this.recordingConfigured) return;
    try {
      await this.dependencies.releaseRecording();
      this.recordingConfigured = false;
    } catch {
      // Final cleanup retries if the prompt release before transcription fails.
    }
  }

  private invalidateOperation(): void {
    this.operationToken += 1;
    this.transcriptionAbortController?.abort();
  }

  private isCurrent(operationToken: number): boolean {
    return operationToken === this.operationToken;
  }

  private setError(error: string, errorAction: VoiceInputState["errorAction"]): void {
    this.setState({ phase: "error", error, errorAction, notice: null });
  }

  private setState(state: VoiceInputState): void {
    this.state = state;
    this.dependencies.onStateChange(state);
  }
}

export function resetVoiceInputGlobalsForTests(): void {
  activeSession = null;
  activeTranscriptionOperation = null;
}
