import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { providerEnabledPatch, resolveProviderSignInPresentation } from "./provider-setup-state";

const provider = Schema.decodeSync(ServerProvider)({
  instanceId: "antigravity",
  driver: "antigravity",
  enabled: false,
  installed: false,
  version: null,
  status: "disabled",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-09-02T00:00:00.000Z",
  models: [],
});

describe("resolveProviderSignInPresentation", () => {
  const completedFlow = { phase: "succeeded", message: "Google sign-in is complete." } as const;

  it("offers sign-in after saved credentials expire, even if the old flow succeeded", () => {
    expect(
      resolveProviderSignInPresentation(
        {
          enabled: true,
          auth: { status: "authenticated" },
        },
        completedFlow,
      ),
    ).toEqual({
      signedIn: true,
      showSignOut: true,
      message: completedFlow.message,
    });

    expect(
      resolveProviderSignInPresentation(
        {
          enabled: true,
          auth: { status: "unauthenticated" },
        },
        completedFlow,
      ),
    ).toEqual({
      signedIn: false,
      showSignOut: false,
      message: null,
    });
  });

  it("allows credential cleanup without claiming a disabled unknown account is signed in", () => {
    expect(
      resolveProviderSignInPresentation(
        {
          enabled: false,
          auth: { status: "unknown" },
        },
        completedFlow,
      ),
    ).toEqual({
      signedIn: false,
      showSignOut: true,
      message: null,
    });
  });

  it("keeps progress while Google sign-in is still pending", () => {
    const flow = { phase: "verifying", message: "Checking Google sign-in." } as const;
    expect(
      resolveProviderSignInPresentation(
        {
          enabled: true,
          auth: { status: "unauthenticated" },
        },
        flow,
      ),
    ).toEqual({
      signedIn: false,
      showSignOut: false,
      message: flow.message,
    });
  });
});

describe("providerEnabledPatch", () => {
  it("enables a legacy instance without losing its executable path or models", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        antigravity: {
          ...DEFAULT_SERVER_SETTINGS.providers.antigravity,
          enabled: false,
          binaryPath: "/opt/google/agy-acp",
          customModels: ["gemini-native"],
        },
      },
    };
    const patch = providerEnabledPatch(settings, provider, true);
    const instance = patch?.providerInstances?.[provider.instanceId];

    expect(instance).toMatchObject({
      enabled: true,
      config: { binaryPath: "/opt/google/agy-acp", customModels: ["gemini-native"] },
    });
    expect(instance?.config).not.toHaveProperty("enabled");
    expect(instance && resolveProviderInstanceEnabled(instance)).toBe(true);
    expect(settings.providers.antigravity.enabled).toBe(false);
  });

  it("keeps separate accounts and environment overrides when enabling a custom instance", () => {
    const workId = ProviderInstanceId.make("google_work");
    const personalId = ProviderInstanceId.make("google_personal");
    const personal = { driver: ProviderDriverKind.make("antigravity"), enabled: true };
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [personalId]: personal,
        [workId]: {
          driver: ProviderDriverKind.make("antigravity"),
          displayName: "Work Google",
          enabled: false,
          config: { enabled: false, binaryPath: "/work/agy-acp", futureSetting: "keep" },
          environment: [{ name: "WORK_PROXY", value: "http://proxy", sensitive: false }],
        },
      },
    };
    const patch = providerEnabledPatch(settings, { ...provider, instanceId: workId }, true);

    expect(patch?.providerInstances?.[personalId]).toBe(personal);
    expect(patch?.providerInstances?.[workId]).toMatchObject({
      displayName: "Work Google",
      enabled: true,
      config: { binaryPath: "/work/agy-acp", futureSetting: "keep" },
      environment: [{ name: "WORK_PROXY", value: "http://proxy", sensitive: false }],
    });
    expect(patch?.providers).toBeUndefined();
  });

  it("does not change a driver without a legacy enabled flag", () => {
    expect(
      providerEnabledPatch(
        DEFAULT_SERVER_SETTINGS,
        {
          ...provider,
          driver: ProviderDriverKind.make("cursor"),
        },
        true,
      ),
    ).toBeNull();
  });

  it.each(["claudeAgent", "codex"] as const)("handles the %s driver", (driver) => {
    const target = { ...provider, driver: ProviderDriverKind.make(driver) };

    const patch = providerEnabledPatch(DEFAULT_SERVER_SETTINGS, target, true);

    expect(patch?.providerInstances?.[target.instanceId]).toMatchObject({ enabled: true });
  });
});
