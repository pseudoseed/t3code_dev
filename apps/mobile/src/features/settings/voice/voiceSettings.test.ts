import { resolveDiarizerInstallation } from "../../../native/speakerFilteringModel";
import { describe, expect, it } from "vite-plus/test";
import type { VoiceModelEnvironment } from "@t3tools/client-runtime/voice-input";

import {
  formatModelSize,
  formatVoiceStorageUsage,
  resolveCleanupModelRows,
  resolveSpeakerFilteringPresentation,
  resolveSpeechModelRows,
  type VoiceModelRow,
  type VoiceModelsSnapshot,
} from "./voiceSettings";

const GB = 1024 * 1024 * 1024;

const roomyDevice: VoiceModelEnvironment = {
  iosMajorVersion: 26,
  availableMemoryBytes: 8 * GB,
  supportedBackends: ["whisperKit", "fluidAudio", "llamaCpp", "appleSpeechAnalyzer"],
};

function snapshot(overrides: Partial<VoiceModelsSnapshot> = {}): VoiceModelsSnapshot {
  return {
    environment: roomyDevice,
    installedModelIds: [],
    selectedSpeechModelId: null,
    selectedCleanupModelId: null,
    downloads: {},
    failures: {},
    ...overrides,
  };
}

function rowFor(rows: readonly VoiceModelRow[], id: string): VoiceModelRow {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

describe("model rows", () => {
  it("offers a download for a model that is not on the device yet", () => {
    const row = rowFor(resolveSpeechModelRows(snapshot()), "whisper-small-en");
    expect(row.state).toEqual({ kind: "downloadable" });
    expect(row.sizeText).toBe("467 MB");
    expect(row.canDelete).toBe(false);
  });

  it("keeps installed selections visible after their models consume free memory", () => {
    const current = snapshot({
      environment: { ...roomyDevice, availableMemoryBytes: 64 * 1024 * 1024 },
      installedModelIds: ["parakeet-v3", "qwen-4b"],
      selectedSpeechModelId: "parakeet-v3",
      selectedCleanupModelId: "qwen-4b",
    });
    expect(rowFor(resolveSpeechModelRows(current), "parakeet-v3").state.kind).toBe("selected");
    expect(rowFor(resolveCleanupModelRows(current), "qwen-4b").state.kind).toBe("selected");
    expect(rowFor(resolveSpeechModelRows(current), "whisper-small-en").state.kind).toBe(
      "unavailable",
    );
    expect(
      rowFor(resolveSpeechModelRows({ ...current, installedModelIds: [] }), "parakeet-v3").state
        .kind,
    ).toBe("unavailable");
  });

  it("treats a bundled model as always present and never deletable", () => {
    const row = rowFor(resolveSpeechModelRows(snapshot()), "whisper-tiny-en");
    expect(row.state).toEqual({ kind: "installed" });
    expect(row.sizeText).toBe("");
    expect(row.canDelete).toBe(false);
  });

  it("marks the user's selection and lets a downloaded model be deleted", () => {
    const rows = resolveSpeechModelRows(
      snapshot({
        installedModelIds: ["whisper-small-en"],
        selectedSpeechModelId: "whisper-small-en",
      }),
    );
    const row = rowFor(rows, "whisper-small-en");
    expect(row.state).toEqual({ kind: "selected" });
    expect(row.canDelete).toBe(true);
  });

  it("shows a model the device cannot run as disabled with the reason", () => {
    const rows = resolveSpeechModelRows(
      snapshot({ environment: { ...roomyDevice, availableMemoryBytes: 200 * 1024 * 1024 } }),
    );
    expect(rowFor(rows, "parakeet-v3").state).toEqual({
      kind: "unavailable",
      reason: "Not enough memory on this device",
    });
  });

  it("shows Apple's recognizer as needing a newer iOS below 26", () => {
    const rows = resolveSpeechModelRows(
      snapshot({ environment: { ...roomyDevice, iosMajorVersion: 18 } }),
    );
    expect(rowFor(rows, "apple-speech-analyzer").state).toEqual({
      kind: "unavailable",
      reason: "Needs a newer iOS",
    });
  });

  it("reports a failed download instead of quietly offering it again", () => {
    const rows = resolveCleanupModelRows(
      snapshot({ failures: { "qwen-2b": "No space left on this device." } }),
    );
    expect(rowFor(rows, "qwen-2b").state).toEqual({
      kind: "failed",
      message: "No space left on this device.",
    });
  });

  it("shows two downloads running at once, each with its own progress", () => {
    const rows = resolveCleanupModelRows(
      snapshot({ downloads: { "qwen-0-8b": 0.5, "qwen-2b": 0.1 } }),
    );

    expect(rowFor(rows, "qwen-0-8b").state).toEqual({ kind: "downloading", fraction: 0.5 });
    expect(rowFor(rows, "qwen-2b").state).toEqual({ kind: "downloading", fraction: 0.1 });
    expect(rowFor(rows, "qwen-4b").state).toEqual({ kind: "downloadable" });
  });

  it("shows progress for the download in flight", () => {
    const rows = resolveCleanupModelRows(snapshot({ downloads: { "qwen-0-8b": 0.25 } }));
    expect(rowFor(rows, "qwen-0-8b").state).toEqual({ kind: "downloading", fraction: 0.25 });
  });

  it("disables everything when the module is missing", () => {
    const rows = resolveSpeechModelRows(snapshot({ environment: null }));
    expect(rows.every((row) => row.state.kind === "unavailable")).toBe(true);
  });
});

describe("resolveSpeakerFilteringPresentation", () => {
  it.each([
    { label: "fresh install", ids: [], enabled: false, needsDownload: true, needsUpdate: false },
    {
      label: "legacy install",
      ids: ["fluid-diarizer"],
      enabled: true,
      needsDownload: false,
      needsUpdate: true,
    },
    {
      label: "current install",
      ids: ["fluid-diarizer-offline"],
      enabled: true,
      needsDownload: false,
      needsUpdate: false,
    },
    {
      label: "completed update",
      ids: ["fluid-diarizer", "fluid-diarizer-offline"],
      enabled: true,
      needsDownload: false,
      needsUpdate: false,
    },
  ])(
    "offers the right download without disabling $label",
    ({ ids, enabled, needsDownload, needsUpdate }) => {
      const installation = resolveDiarizerInstallation(ids);
      const presentation = resolveSpeakerFilteringPresentation({
        selectedSpeechModelId: "parakeet-v3",
        diarizerInstalled: installation.installedModelId !== null,
        diarizerNeedsUpdate: installation.needsUpdate,
        diarizerSizeText: "22 MB",
      });
      expect(presentation.enabled).toBe(enabled);
      expect(presentation.needsDiarizer).toBe(needsDownload);
      expect(installation.needsUpdate).toBe(needsUpdate);
      if (needsUpdate) {
        expect(presentation.subtitle).toContain("22 MB update");
        expect(presentation.subtitle).toContain("Current filtering stays active");
      }
      if (ids.includes("fluid-diarizer-offline")) {
        expect(installation.installedModelId).toBe("fluid-diarizer-offline");
      }
    },
  );

  it("stays off for a model whose backend cannot tell voices apart", () => {
    const presentation = resolveSpeakerFilteringPresentation({
      selectedSpeechModelId: "whisper-tiny-en",
      diarizerInstalled: true,
      diarizerSizeText: "25 MB",
    });

    expect(presentation.enabled).toBe(false);
    expect(presentation.needsDiarizer).toBe(false);
    expect(presentation.subtitle).toContain("Parakeet v3");
  });

  it("asks for the separation model before it can run", () => {
    const presentation = resolveSpeakerFilteringPresentation({
      selectedSpeechModelId: "parakeet-v3",
      diarizerInstalled: false,
      diarizerSizeText: "25 MB",
    });

    expect(presentation.enabled).toBe(false);
    expect(presentation.needsDiarizer).toBe(true);
    expect(presentation.subtitle).toContain("25 MB");
  });

  it("is usable once the model and the separation model are both there", () => {
    expect(
      resolveSpeakerFilteringPresentation({
        selectedSpeechModelId: "parakeet-v3",
        diarizerInstalled: true,
        diarizerSizeText: "25 MB",
      }),
    ).toMatchObject({ enabled: true, needsDiarizer: false });
  });
});

describe("size formatting", () => {
  it("switches to gigabytes past a thousand megabytes", () => {
    expect(formatModelSize(467 * 1024 * 1024)).toBe("467 MB");
    expect(formatModelSize(2614 * 1024 * 1024)).toBe("2.6 GB");
    expect(formatModelSize(0)).toBe("");
  });

  it("says nothing is downloaded rather than showing a zero", () => {
    expect(formatVoiceStorageUsage(0)).toBe("Nothing downloaded");
    expect(formatVoiceStorageUsage(1024 * 1024 * 100)).toBe("100 MB");
  });
});
