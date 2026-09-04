# Third-Party Notices

On-device dictation links two inference engines and ships one speech model
inside the app. None of them send audio or text anywhere.

## WhisperKit

CoreML speech recognition, resolved through Swift Package Manager from the
podspec.

- Upstream project: https://github.com/argmaxinc/WhisperKit
- Pinned version: `0.18.0`, exact
- License: MIT

## Whisper tiny.en (bundled speech model)

The model that makes dictation work offline on first launch, before anything is
downloaded. `scripts/fetch-bundled-model.sh` downloads it; the weights are not
in git.

- Weights: https://huggingface.co/argmaxinc/whisperkit-coreml
  at `0f63a7800b00dd0226abd051b906c246e1907482`
- Tokenizer: https://huggingface.co/openai/whisper-tiny.en
  at `87c7102498dcde7456f24cfd30239ca606ed9063`
- License: MIT (OpenAI Whisper), Apache 2.0 (WhisperKit conversions)

## FluidAudio

Speech recognition (Parakeet v3) and speaker diarization, resolved through Swift
Package Manager from the podspec.

- Upstream project: https://github.com/FluidInference/FluidAudio
- Pinned version: `0.15.5`, exact
- License: Apache 2.0

## llama.cpp

Transcript cleanup runs on llama.cpp directly. `scripts/build-llama-xcframework.sh`
builds the iOS device and simulator slices from upstream source; the framework
is not in git.

Vendored rather than resolved through Swift Package Manager because every Swift
wrapper around llama.cpp depends on SwiftSyntax, which does not build inside a
CocoaPods workspace, and llama.cpp's own published xcframework has no iOS
simulator slice.

- Upstream project: https://github.com/ggml-org/llama.cpp
- Pinned tag: `b10793`
- License: MIT

Keep this notice in sync with the pins in `ios/T3Voice.podspec` and
`scripts/build-llama-xcframework.sh`.
