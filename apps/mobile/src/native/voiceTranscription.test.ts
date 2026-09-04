import { describe, expect, it } from "vite-plus/test";

import { getLocalVoiceCleanup } from "./voiceCleanup";
import { getLocalVoiceTranscriber, readVoiceModelEnvironmentForApp } from "./voiceTranscription";

/**
 * On-device dictation ships for iOS and iPadOS only. Metro resolves these
 * modules on every other platform, so they have to answer "nothing here"
 * rather than reach for a native module that does not exist.
 */
describe("non-iOS voice bindings", () => {
  it("offers no transcriber, no cleanup, and no model environment", () => {
    expect(getLocalVoiceTranscriber({ speechModelId: null, speakerFiltering: false })).toBeNull();
    expect(
      getLocalVoiceCleanup({ enabled: true, modelId: "qwen-0-8b", systemPrompt: "clean this" }),
    ).toBeNull();
    expect(readVoiceModelEnvironmentForApp()).toBeNull();
  });
});
