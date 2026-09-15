import { describe, expect, it } from "vite-plus/test";

import {
  resolveAgentAwarenessPlatformPresentation,
  resolveVoicePlatformPresentation,
} from "./SettingsRouteScreen.logic";

describe("resolveAgentAwarenessPlatformPresentation", () => {
  it("supports agent awareness settings on Android", () => {
    expect(resolveAgentAwarenessPlatformPresentation("android")).toEqual({
      supported: true,
      subtitle: undefined,
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
