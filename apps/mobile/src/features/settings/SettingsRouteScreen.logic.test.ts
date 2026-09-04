import { describe, expect, it } from "vite-plus/test";

import {
  resolveAgentAwarenessPlatformPresentation,
  resolveVoicePlatformPresentation,
} from "./SettingsRouteScreen.logic";

describe("resolveAgentAwarenessPlatformPresentation", () => {
  it("explains that agent awareness settings are unavailable on Android", () => {
    expect(resolveAgentAwarenessPlatformPresentation("android")).toEqual({
      supported: false,
      subtitle: "iOS only",
    });
  });

  it("leaves supported iOS settings unchanged", () => {
    expect(resolveAgentAwarenessPlatformPresentation("ios")).toEqual({
      supported: true,
      subtitle: undefined,
    });
  });
});

describe("resolveVoicePlatformPresentation", () => {
  it("keeps the row on Android and says why it does nothing there", () => {
    expect(resolveVoicePlatformPresentation("android")).toEqual({
      supported: false,
      value: "iOS only",
    });
    expect(resolveVoicePlatformPresentation("ios")).toEqual({ supported: true, value: undefined });
  });
});
