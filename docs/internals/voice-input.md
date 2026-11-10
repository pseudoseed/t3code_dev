# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. The current implementation transcribes locally on supported iOS devices;
environment-backed transcription is not implemented.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.

## On-device models (PseudoCode)

The fork swaps the transcriber handed to the controller: the
[dictation transcriber](../../apps/mobile/src/features/dictation/dictationTranscriber.ts) wraps
the system one and runs a downloaded model through the
[native module](../../apps/mobile/modules/pseudo-dictation). Fork code stays in
`features/dictation`, `modules/pseudo-dictation` and `plugins/withDictationPods.cjs`. Upstream
files only import from them, at the end of their import block, so upstream merges stay small.

- The controller awaits preparation before it records, so preparation never waits on a model.
  The model loads while the user talks, and the system recognizer stands in for a model that is
  missing, still compiling, or failed on the recording.
- FluidAudio is a git pod pinned to a commit and added by the config plugin to the app target
  only. The widget extension must not link it.
- The engine reaches the network only inside an explicit download.
- The voice filter never runs on the GPU, because iOS refuses GPU work in the background, where a
  dictation may finish.
- The thresholds in [SpeakerFilter](../../apps/mobile/modules/pseudo-dictation/ios/Core/SpeakerFilter.swift)
  come from measurement and lean towards keeping a stranger's words over cutting the user's.
  `RealVoiceTests` measures them on recordings of real people; rerun it before changing one.
- `ios/Core` builds as a Swift package on macOS so `swift test` covers it without a simulator.
  The Expo module file is outside that package and compiles only in an iOS build.
