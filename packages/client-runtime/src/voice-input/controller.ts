import * as Schema from "effect/Schema";
import { replaceTextRange } from "@t3tools/shared/composerTrigger";

import {
  VoiceTranscriptionError,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
} from "./transcription.ts";

const isVoiceTranscriptionError = Schema.is(VoiceTranscriptionError);

export const VOICE_RECORDING_LIMIT_SECONDS = 5 * 60;

export type VoiceInputPhase = "idle" | "preparing" | "recording" | "transcribing" | "error";

export type VoiceInputState = {
  readonly phase: VoiceInputPhase;
  readonly error: string | null;
  /** "retry" records again; "transcribe" runs the recording that was kept through the model again. */
  readonly errorAction: "retry" | "transcribe" | "settings" | null;
};

export function voiceInputBlocksSubmission(state: VoiceInputState): boolean {
  return (
    state.phase === "preparing" || state.phase === "recording" || state.phase === "transcribing"
  );
}

export type VoiceDraftSnapshot = {
  readonly ownerKey: string;
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly revision: number;
};

export type VoiceRecorderStatus = {
  readonly isFinished: boolean;
  readonly hasError: boolean;
  readonly error: string | null;
  readonly url: string | null;
};

export interface VoiceRecorder {
  readonly uri: string | null;
  prepareToRecordAsync(signal?: AbortSignal): Promise<void>;
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
  /** Moves a finished recording to where recordings are kept, and returns where it is now. */
  readonly keepRecording: (uri: string) => string;
  readonly readDraft: () => VoiceDraftSnapshot | null;
  readonly commitDraft: (
    text: string,
    selection: { readonly start: number; readonly end: number },
  ) => void;
  readonly onStateChange: (state: VoiceInputState) => void;
};

type TranscriptCommitResult =
  | {
      readonly kind: "commit";
      readonly text: string;
      readonly selection: { readonly start: number; readonly end: number };
    }
  | { readonly kind: "stale" }
  | { readonly kind: "empty" };

export function resolveTranscriptCommit(
  captured: VoiceDraftSnapshot,
  current: VoiceDraftSnapshot | null,
  transcript: string,
  locale: string,
): TranscriptCommitResult {
  if (!current || current.ownerKey !== captured.ownerKey) {
    return { kind: "stale" };
  }

  const replacement = transcript.trim();
  if (replacement.length === 0) {
    return { kind: "empty" };
  }

  // The caret recorded at the start means nothing in an edited draft, so the words go at its end.
  const edited = current.text !== captured.text || current.revision !== captured.revision;
  const text = current.text;
  const selection = edited ? { start: text.length, end: text.length } : captured.selection;
  const isEmptySelection = selection.start === selection.end;
  const normalizedLocale = locale.replaceAll("_", "-").toLowerCase();
  const usesEnglishSpacing = normalizedLocale === "en" || normalizedLocale.startsWith("en-");
  let insertion = replacement;
  if (isEmptySelection && usesEnglishSpacing) {
    const left = text[selection.start - 1];
    const right = text[selection.start];
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

  const result = replaceTextRange(text, selection.start, selection.end, insertion);
  return {
    kind: "commit",
    text: result.text,
    selection: { start: result.cursor, end: result.cursor },
  };
}

type VoiceInputSession = {
  abandoned: boolean;
  readonly released: Promise<void>;
  readonly release: () => void;
};

let activeSession: VoiceInputSession | null = null;
let activeTranscriptionOperation: Promise<unknown> | null = null;

function acquireSession(): VoiceInputSession | null {
  if (activeSession) return null;
  const { promise, resolve } = Promise.withResolvers<void>();
  const token = { abandoned: false, released: promise, release: resolve };
  activeSession = token;
  return token;
}

function releaseSession(token: VoiceInputSession | null): void {
  if (token && activeSession === token) {
    activeSession = null;
    token.release();
  }
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
  return isVoiceTranscriptionError(error)
    ? error.message
    : "Could not prepare voice transcription.";
}

function transcriptionErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "voice-operation-busy") {
    return "Voice transcription is still finishing. Try again shortly.";
  }
  return isVoiceTranscriptionError(error) ? error.message : "Could not transcribe this recording.";
}

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };
const RECORDING_STOPPED_EARLY_MESSAGE =
  "Voice recording stopped early. The words it captured were added.";
const RECORDING_LIMIT_MESSAGE =
  "Voice recording reached the 5 minute limit. The words up to it were added.";

type KeptRecording = {
  readonly uri: string;
  /** Where the recorder wrote it. The file is no longer there once it was moved. */
  readonly source: string;
  readonly draft: VoiceDraftSnapshot | null;
};

export class VoiceInputController {
  private readonly dependencies: VoiceInputControllerDependencies;
  private state: VoiceInputState = IDLE_STATE;
  private operationToken = 0;
  private sessionToken: VoiceInputSession | null = null;
  private transcription: PreparedVoiceTranscription | null = null;
  private transcriptionAbortController: AbortController | null = null;
  private capturedDraft: VoiceDraftSnapshot | null = null;
  private recordingUri: string | null = null;
  private readonly ownedRecordingUris = new Set<string>();
  private recordingConfigured = false;
  private recordingStarted = false;
  private kept: KeptRecording | null = null;
  private finishing = false;

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
    let sessionToken: VoiceInputSession | null = null;
    const operationToken = ++this.operationToken;
    this.setState({ phase: "preparing", error: null, errorAction: null });

    try {
      for (
        let previousSession = activeSession;
        previousSession?.abandoned;
        previousSession = activeSession
      ) {
        await previousSession.released;
        if (!this.isCurrent(operationToken)) return;
      }
      sessionToken = acquireSession();
      if (!sessionToken) {
        this.setError("Another voice recording is already active.", "retry");
        return;
      }
      this.sessionToken = sessionToken;
      const abortController = new AbortController();
      this.transcriptionAbortController = abortController;

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
      await this.dependencies.recorder.prepareToRecordAsync(abortController.signal);
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
      this.recordingStarted = true;
      this.setState({ phase: "recording", error: null, errorAction: null });
    } catch {
      if (this.isCurrent(operationToken))
        this.setError("Could not start voice recording.", "retry");
    } finally {
      if (sessionToken && this.sessionToken === sessionToken) {
        if (this.isCurrent(operationToken) && this.state.phase === "error") {
          await this.releaseResources();
        } else if (!this.isCurrent(operationToken) && !this.finishing) {
          await this.releaseResources();
        }
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
        return;
      case "error":
        this.setState(IDLE_STATE);
        return;
      case "preparing":
        this.invalidateOperation();
        this.setState(IDLE_STATE);
        return;
      case "recording":
        void this.discardRecording();
        return;
      case "transcribing":
        this.invalidateOperation();
        this.setState(IDLE_STATE);
        return;
    }
  }

  /** Runs the kept recording through the model again, after a transcription that failed. */
  async retranscribe(): Promise<void> {
    const kept = this.kept;
    if (this.state.phase !== "error" || this.state.errorAction !== "transcribe" || !kept?.draft) {
      return;
    }
    const capturedDraft = kept.draft;
    let sessionToken: VoiceInputSession | null = null;
    const operationToken = ++this.operationToken;
    this.setState({ phase: "transcribing", error: null, errorAction: null });

    try {
      for (
        let previousSession = activeSession;
        previousSession?.abandoned;
        previousSession = activeSession
      ) {
        await previousSession.released;
        if (!this.isCurrent(operationToken)) return;
      }
      sessionToken = acquireSession();
      if (!sessionToken) {
        this.setError("Another voice recording is already active.", "transcribe");
        return;
      }
      this.sessionToken = sessionToken;
      const abortController = new AbortController();
      this.transcriptionAbortController = abortController;
      const { signal } = abortController;

      const transcriber = this.dependencies.getTranscriber();
      if (!transcriber) {
        this.setError("Voice transcription is not available.", "transcribe");
        return;
      }

      let transcript: string;
      let locale: string;
      try {
        const transcription = await runTranscriptionOperation(() =>
          transcriber.prepare({ signal }),
        );
        if (!this.isCurrent(operationToken)) return;
        transcript = await runTranscriptionOperation(() =>
          transcription.transcribe(kept.uri, { signal }),
        );
        locale = transcription.locale;
      } catch (error) {
        if (this.isCurrent(operationToken)) {
          this.setError(transcriptionErrorMessage(error), "transcribe");
        }
        return;
      }
      if (!this.isCurrent(operationToken)) return;
      this.commitTranscript(capturedDraft, transcript, locale, null, null);
    } catch {
      if (this.isCurrent(operationToken)) {
        this.setError("Could not finish voice recording.", "transcribe");
      }
    } finally {
      if (sessionToken && this.sessionToken === sessionToken) await this.releaseResources();
    }
  }

  interruptRecording(
    message = "Voice recording was interrupted.",
    completedUri: string | null = null,
  ): Promise<void> | void {
    if (this.state.phase !== "recording") return;
    return this.finishRecording(
      completedUri !== null,
      completedUri,
      RECORDING_STOPPED_EARLY_MESSAGE,
      message,
    );
  }

  /** The recorder ends a recording by itself, without an error, only at the limit. */
  recordingReachedLimit(completedUri: string | null = null): Promise<void> | void {
    if (this.state.phase !== "recording") return;
    return this.finishRecording(completedUri !== null, completedUri, RECORDING_LIMIT_MESSAGE);
  }

  appMovedToBackground(): Promise<void> | void {
    if (this.state.phase === "preparing") {
      this.invalidateOperation();
      this.setError("Voice input stopped when the app moved to the background.", "retry");
      return;
    }
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
      return this.recordingReachedLimit(status.url);
    }
  }

  ownerChanged(): void {
    if (this.state.phase === "idle") return;
    this.cancel();
  }

  dispose(): void {
    if (this.state.phase === "recording") {
      void this.discardRecording();
      return;
    }
    if (this.state.phase === "preparing" || this.state.phase === "transcribing") {
      this.invalidateOperation();
      this.setState(IDLE_STATE);
    }
  }

  /**
   * `notice` is set when the recording ended without the user stopping it, and is shown once its
   * words are added. `failure` is shown instead when there were no words to add.
   */
  private async finishRecording(
    alreadyStopped: boolean,
    completedUri: string | null,
    notice: string | null = null,
    failure: string | null = null,
  ): Promise<void> {
    if (this.finishing || this.state.phase !== "recording") return;
    this.finishing = true;
    const operationToken = this.operationToken;
    let keptRecording = false;
    this.setState({ phase: "transcribing", error: null, errorAction: null });

    try {
      if (!alreadyStopped) {
        try {
          await this.dependencies.recorder.stop();
        } catch {
          // A recorder that fails to stop, or is already gone, has still written its file.
        }
      }
      await this.releaseAudioSession();
      // The file capture started in wins: a media-services reset gives the recorder a new, empty one.
      const recordingUri = this.keep(
        completedUri ?? this.recordingUri ?? this.dependencies.recorder.uri,
      );
      keptRecording = recordingUri !== null;
      if (!this.isCurrent(operationToken)) return;
      if (
        !recordingUri ||
        !this.transcription ||
        !this.transcriptionAbortController ||
        !this.capturedDraft
      ) {
        this.setError("Could not finish voice recording.", "retry");
        return;
      }

      const transcription = this.transcription;
      const signal = this.transcriptionAbortController.signal;
      const capturedDraft = this.capturedDraft;
      let transcript: string;
      try {
        transcript = await runTranscriptionOperation(() =>
          transcription.transcribe(recordingUri, { signal }),
        );
      } catch (error) {
        if (this.isCurrent(operationToken)) {
          this.setError(failure ?? transcriptionErrorMessage(error), "transcribe");
        }
        return;
      }
      if (!this.isCurrent(operationToken)) return;
      this.commitTranscript(capturedDraft, transcript, transcription.locale, notice, failure);
    } catch {
      if (this.isCurrent(operationToken)) {
        this.setError("Could not finish voice recording.", keptRecording ? "transcribe" : "retry");
      }
    } finally {
      this.finishing = false;
      await this.releaseResources();
    }
  }

  private commitTranscript(
    capturedDraft: VoiceDraftSnapshot,
    transcript: string,
    locale: string,
    notice: string | null,
    failure: string | null,
  ): void {
    const result = resolveTranscriptCommit(
      capturedDraft,
      this.dependencies.readDraft(),
      transcript,
      locale,
    );
    if (result.kind === "stale") {
      this.setError(
        "The draft is gone, so the words were not added. The recording is kept.",
        "retry",
      );
      return;
    }
    if (result.kind === "empty") {
      this.setError(failure ?? "No speech was detected.", "retry");
      return;
    }

    this.dependencies.commitDraft(result.text, result.selection);
    // No retry with a notice: a new recording would go in at the caret this one started at.
    if (notice === null) this.setState(IDLE_STATE);
    else this.setError(notice, null);
  }

  private async discardRecording(): Promise<void> {
    this.invalidateOperation();
    this.setState(IDLE_STATE);
    await this.releaseResources();
  }

  /** A recording outlives its dictation, whatever became of it, so its words can be recovered. */
  private keep(uri: string | null): string | null {
    this.recordingStarted = false;
    if (!uri) return null;
    let keptUri = uri;
    try {
      keptUri = this.dependencies.keepRecording(uri);
    } catch {
      // It stays where the recorder wrote it.
    }
    this.kept = { uri: keptUri, source: uri, draft: this.capturedDraft };
    return keptUri;
  }

  private async releaseResources(): Promise<void> {
    this.rememberRecordingUri(this.recordingUri);
    try {
      this.rememberRecordingUri(this.dependencies.recorder.uri);
    } catch {}
    if (this.recordingConfigured) {
      try {
        await this.dependencies.recorder.stop();
      } catch {}
    }
    // A recording that was canceled, or abandoned before it finished, is kept as well.
    if (this.recordingStarted) this.keep(this.recordingUri);
    this.recordingUri = null;
    for (const uri of this.ownedRecordingUris) {
      if (uri === this.kept?.uri || uri === this.kept?.source) continue;
      try {
        this.dependencies.deleteRecording(uri);
      } catch {}
    }
    this.ownedRecordingUris.clear();
    await this.releaseAudioSession();
    releaseSession(this.sessionToken);
    this.sessionToken = null;
    this.capturedDraft = null;
    this.transcription = null;
    this.transcriptionAbortController = null;
  }

  private rememberRecordingUri(uri: string | null): void {
    if (uri) this.ownedRecordingUris.add(uri);
  }

  private async releaseAudioSession(): Promise<void> {
    if (!this.recordingConfigured) return;
    try {
      await this.dependencies.releaseRecording();
      this.recordingConfigured = false;
    } catch {}
  }

  private invalidateOperation(): void {
    this.operationToken += 1;
    if (this.sessionToken) this.sessionToken.abandoned = true;
    this.transcriptionAbortController?.abort();
  }

  private isCurrent(operationToken: number): boolean {
    return operationToken === this.operationToken;
  }

  private setError(error: string, errorAction: VoiceInputState["errorAction"]): void {
    this.setState({ phase: "error", error, errorAction });
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
