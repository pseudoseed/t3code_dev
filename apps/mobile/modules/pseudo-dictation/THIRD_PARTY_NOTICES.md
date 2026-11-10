# Third-party notices

On-device dictation in PseudoCode is built on the work below.

## Shipped in the app

**FluidAudio** by Fluid Inference, Apache License 2.0.
https://github.com/FluidInference/FluidAudio (commit `c8b41f98eae668794dd0083bbe028fe7e6585051`, v0.18.3).
Its licence text and the notices for the code it bundles are in that repository's `LICENSE` and
`ThirdPartyLicenses/`.

**`ios/Resources/dictation-sample.wav`** is FluidAudio's test fixture
`Tests/FluidAudioTests/ASR/Parakeet/SlidingWindow/Fixtures/03-diff-explanation-16.9s.wav`, unchanged,
under the same Apache License 2.0.

## Downloaded on the device when the user asks for them

These models are not part of the app. They are fetched from Hugging Face. All are Core ML
conversions by Fluid Inference, modified from the originals named here.

| Model in the app | Repository                                                                                    | Original                                                                                                                  | Licence   |
| ---------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------- |
| Fast             | `FluidInference/parakeet-tdt-ctc-110m-coreml`                                                 | NVIDIA `parakeet-tdt_ctc-110m`                                                                                            | CC BY 4.0 |
| Balanced         | `FluidInference/parakeet-tdt-0.6b-v3-coreml`                                                  | NVIDIA `parakeet-tdt-0.6b-v3`                                                                                             | CC BY 4.0 |
| Most accurate    | `FluidInference/parakeet-ultra-coreml`                                                        | moondream `parakeet-ultra`, trained from NVIDIA Parakeet v3                                                               | CC BY 4.0 |
| Voice filter     | `FluidInference/speaker-diarization-coreml` (`Segmentation`, `FBank`, `Embedding`, `PldaRho`) | `pyannote/speaker-diarization-community-1` by pyannote, with WeSpeaker embeddings and PLDA parameters from BUT Speech@FIT | CC BY 4.0 |

CC BY 4.0: https://creativecommons.org/licenses/by/4.0/

The voice filter repository holds files under more than one licence. Its `NOTICE.md` says which
licence covers which file; the 4 files above are in its CC BY 4.0 set:
https://huggingface.co/FluidInference/speaker-diarization-coreml/blob/main/NOTICE.md
