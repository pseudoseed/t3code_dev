import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_CLEANUP_PROMPT } from "@t3tools/client-runtime/voice-input";

import { resolveRecoverableTranscript, resolveVoiceCleanupSettings } from "./voiceCleanupSettings";

describe("resolveVoiceCleanupSettings", () => {
  it("leaves cleanup off until the user turns it on", () => {
    expect(resolveVoiceCleanupSettings({})).toEqual({
      enabled: false,
      modelId: null,
      systemPrompt: DEFAULT_CLEANUP_PROMPT,
    });
  });

  it("puts learned corrections in the prompt, with typed ones winning", () => {
    const settings = resolveVoiceCleanupSettings({
      voiceCleanupEnabled: true,
      voiceCleanupCorrections: "ghosty -> Ghostty",
      voiceLearnedCorrections: [
        { wrong: "Ghosty", right: "ghost tea" },
        { wrong: "xcode", right: "Xcode" },
      ],
    });

    expect(settings.systemPrompt).toContain("- ghosty -> Ghostty");
    expect(settings.systemPrompt).toContain("- xcode -> Xcode");
    expect(settings.systemPrompt).not.toContain("ghost tea");
  });

  it("composes the user's prompt with their correction hints", () => {
    const settings = resolveVoiceCleanupSettings({
      voiceCleanupEnabled: true,
      voiceCleanupModelId: "qwen-2b",
      voiceCleanupPrompt: "Tidy this up.",
      voiceCleanupPreferredSpellings: "Ghostty\nT3 Code",
      voiceCleanupCorrections: "tea three -> T3",
    });

    expect(settings.enabled).toBe(true);
    expect(settings.modelId).toBe("qwen-2b");
    expect(settings.systemPrompt).toContain("Tidy this up.");
    expect(settings.systemPrompt).toContain("- Ghostty");
    expect(settings.systemPrompt).toContain("- tea three -> T3");
  });
});

describe("resolveRecoverableTranscript", () => {
  const SESSION_START = 2_000;
  const pending = {
    voicePendingTranscript: {
      ownerKey: "environment:thread",
      revision: 4,
      text: "  add a retry  ",
      capturedAt: 1_000,
    },
  };

  it("offers a transcript back to the draft it belongs to", () => {
    expect(
      resolveRecoverableTranscript(
        pending,
        { ownerKey: "environment:thread", text: "hello" },
        SESSION_START,
      ),
    ).toBe("add a retry");
  });

  it("ignores a transcript that belongs to another draft", () => {
    expect(
      resolveRecoverableTranscript(
        pending,
        { ownerKey: "environment:other", text: "hello" },
        SESSION_START,
      ),
    ).toBeNull();
    expect(
      resolveRecoverableTranscript(pending, { ownerKey: null, text: "hello" }, SESSION_START),
    ).toBeNull();
  });

  it("does not offer a transcript the draft already has", () => {
    expect(
      resolveRecoverableTranscript(
        pending,
        {
          ownerKey: "environment:thread",
          text: "please add a retry button",
        },
        SESSION_START,
      ),
    ).toBeNull();
  });

  it("does not offer a transcript from the dictation still running", () => {
    const inFlight = {
      voicePendingTranscript: { ...pending.voicePendingTranscript, capturedAt: SESSION_START + 5 },
    };

    expect(
      resolveRecoverableTranscript(
        inFlight,
        { ownerKey: "environment:thread", text: "hello" },
        SESSION_START,
      ),
    ).toBeNull();
  });

  it("returns nothing when there is no pending transcript", () => {
    expect(
      resolveRecoverableTranscript({}, { ownerKey: "environment:thread", text: "" }, SESSION_START),
    ).toBeNull();
  });
});
