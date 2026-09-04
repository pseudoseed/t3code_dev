import { describe, expect, it } from "vite-plus/test";

import {
  APPLE_SPEECH_MODEL_ID,
  BUNDLED_SPEECH_MODEL_ID,
  CLEANUP_MODELS,
  resolveDefaultSpeechModelId,
  resolveModelAvailability,
  SPEECH_MODELS,
  supportsSpeakerFiltering,
  type VoiceModel,
  type VoiceModelBackend,
  type VoiceModelEnvironment,
} from "./models.ts";

const GB = 1024 * 1024 * 1024;

const ALL_BACKENDS: readonly VoiceModelBackend[] = [
  "appleSpeechAnalyzer",
  "whisperKit",
  "fluidAudio",
  "mlxAudio",
  "llamaCpp",
];

function environment(overrides: Partial<VoiceModelEnvironment> = {}): VoiceModelEnvironment {
  return {
    iosMajorVersion: 26,
    availableMemoryBytes: 8 * GB,
    supportedBackends: ALL_BACKENDS,
    ...overrides,
  };
}

function model(id: string): VoiceModel {
  const found = [...SPEECH_MODELS, ...CLEANUP_MODELS].find((entry) => entry.id === id);
  if (!found) throw new Error(`no model ${id}`);
  return found;
}

describe("resolveModelAvailability", () => {
  it("refuses Apple's recognizer below iOS 26", () => {
    expect(resolveModelAvailability(model(APPLE_SPEECH_MODEL_ID), environment())).toEqual({
      available: true,
    });
    expect(
      resolveModelAvailability(model(APPLE_SPEECH_MODEL_ID), environment({ iosMajorVersion: 18 })),
    ).toEqual({ available: false, reason: "requires-newer-ios" });
  });

  it("refuses a model that does not fit the remaining memory budget", () => {
    const large = model("qwen-4b");
    expect(resolveModelAvailability(large, environment({ availableMemoryBytes: 1 * GB }))).toEqual({
      available: false,
      reason: "not-enough-memory",
    });
    expect(resolveModelAvailability(large, environment({ availableMemoryBytes: 8 * GB }))).toEqual({
      available: true,
    });
  });

  it("refuses a model whose backend the installed binary does not implement", () => {
    expect(
      resolveModelAvailability(
        model("nemotron-streaming-en"),
        environment({ supportedBackends: ["whisperKit"] }),
      ),
    ).toEqual({ available: false, reason: "backend-unsupported" });
  });

  it("keeps the bundled model available on the app's lowest supported iOS", () => {
    expect(
      resolveModelAvailability(
        model(BUNDLED_SPEECH_MODEL_ID),
        environment({ iosMajorVersion: 18 }),
      ),
    ).toEqual({ available: true });
  });
});

describe("resolveDefaultSpeechModelId", () => {
  it("prefers Apple on iOS 26 when Apple covers the locale", () => {
    expect(resolveDefaultSpeechModelId(environment(), { localeSupportedByApple: true })).toBe(
      APPLE_SPEECH_MODEL_ID,
    );
  });

  it("falls back to the bundled model on iOS 18 through 25", () => {
    expect(
      resolveDefaultSpeechModelId(environment({ iosMajorVersion: 18 }), {
        localeSupportedByApple: true,
      }),
    ).toBe(BUNDLED_SPEECH_MODEL_ID);
  });

  it("falls back to the bundled model when Apple does not cover the locale", () => {
    expect(resolveDefaultSpeechModelId(environment(), { localeSupportedByApple: false })).toBe(
      BUNDLED_SPEECH_MODEL_ID,
    );
  });

  it("returns null when even the bundled model is refused, so the composer can show setup", () => {
    expect(
      resolveDefaultSpeechModelId(
        environment({ iosMajorVersion: 18, availableMemoryBytes: 1024 }),
        { localeSupportedByApple: false },
      ),
    ).toBeNull();
  });
});

describe("supportsSpeakerFiltering", () => {
  it("is true exactly for the diarizer-backed models", () => {
    const filtering = SPEECH_MODELS.filter(supportsSpeakerFiltering).map((entry) => entry.id);
    expect(filtering).toEqual(["parakeet-v3"]);
  });
});

describe("catalog", () => {
  it("ships exactly one bundled speech model, because it is the offline guarantee", () => {
    const bundled = SPEECH_MODELS.filter((entry) => entry.delivery.kind === "bundled");
    expect(bundled.map((entry) => entry.id)).toEqual([BUNDLED_SPEECH_MODEL_ID]);
  });

  it("gives every downloadable model a size, so the picker can never show a blank", () => {
    for (const entry of [...SPEECH_MODELS, ...CLEANUP_MODELS]) {
      if (entry.delivery.kind !== "download") continue;
      expect(entry.delivery.bytes).toBeGreaterThan(0);
    }
  });

  it("uses unique ids across both catalogs, since preferences store the id", () => {
    const ids = [...SPEECH_MODELS, ...CLEANUP_MODELS].map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
