import {
  ANTIGRAVITY_AUTH_METHODS,
  type AntigravityAuthMethod,
  DEFAULT_SERVER_SETTINGS,
  type ProviderAuthState,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

/** Read the configured method from an instance config. Unknown values fall back to personal. */
export function readAntigravityAuthMethod(config: unknown): AntigravityAuthMethod {
  const value =
    config !== null && typeof config === "object" && "authMethod" in config
      ? config.authMethod
      : undefined;
  return (
    ANTIGRAVITY_AUTH_METHODS.find((method) => method.value === value)?.value ?? "oauth-personal"
  );
}

/** A completed sign-in flow does not prove that saved credentials are still valid. */
export function resolveProviderSignInPresentation(
  provider: Pick<ServerProvider, "enabled" | "auth"> | undefined,
  flow: Pick<ProviderAuthState, "phase" | "message"> | null,
) {
  const signedIn = provider?.auth.status === "authenticated";
  return {
    signedIn,
    showSignOut: signedIn || (provider?.enabled === false && provider.auth.status === "unknown"),
    message: flow?.phase === "succeeded" && !signedIn ? null : (flow?.message ?? null),
  };
}

/** Drivers whose settings still carry a legacy per-driver `enabled` flag. */
const LEGACY_PROVIDER_KEYS = ["antigravity", "claudeAgent", "codex"] as const;
type LegacyProviderKey = (typeof LEGACY_PROVIDER_KEYS)[number];

function legacyProviderKey(driver: string): LegacyProviderKey | null {
  return LEGACY_PROVIDER_KEYS.find((key) => key === driver) ?? null;
}

/**
 * Keep one enabled flag when a legacy provider becomes an explicit instance.
 *
 * The instance whose id equals its driver kind is the migrated one; clearing
 * its legacy `providers.<driver>` block is what stops the old flag from
 * fighting the new per-instance one.
 */
export function providerEnabledPatch(
  settings: ServerSettings,
  provider: ServerProvider,
  enabled: boolean,
): ServerSettingsPatch | null {
  const key = legacyProviderKey(provider.driver);
  if (key === null) return null;

  const { enabled: _legacyEnabled, ...legacyConfig } = settings.providers[key];
  const instance = settings.providerInstances[provider.instanceId] ?? {
    driver: provider.driver,
    config: legacyConfig,
  };
  const config =
    instance.config !== null &&
    typeof instance.config === "object" &&
    !Array.isArray(instance.config)
      ? Object.fromEntries(
          Object.entries(instance.config).filter(([entryKey]) => entryKey !== "enabled"),
        )
      : instance.config;

  return {
    ...(provider.instanceId === key
      ? { providers: { [key]: DEFAULT_SERVER_SETTINGS.providers[key] } }
      : {}),
    providerInstances: {
      ...settings.providerInstances,
      [provider.instanceId]: { ...instance, enabled, config },
    },
  };
}

/** Providers whose setup screen T3 Code can drive. */
export function supportsProviderSetupScreen(driver: string): boolean {
  return legacyProviderKey(driver) !== null;
}

export interface MobileProviderSetupCopy {
  readonly accountLabel: string;
  readonly signInLabel: string;
  readonly retryLabel: string;
  readonly signOutLabel: string;
  readonly signOutTitle: string;
  readonly idleLabel: string;
  readonly startingLabel: string;
  readonly verifyingLabel: string;
  readonly openLabel: string;
  readonly iconProvider: string;
}

/**
 * Copy for the mobile setup screen. Antigravity's API-key methods read as a
 * credential check rather than a sign-in, which is why the method matters and
 * not just the driver.
 */
export function resolveMobileProviderSetupCopy(input: {
  readonly driver: string;
  readonly authMethod: AntigravityAuthMethod;
}): MobileProviderSetupCopy {
  if (input.driver === "claudeAgent") {
    return {
      accountLabel: "Anthropic account",
      signInLabel: "Sign in to Claude",
      retryLabel: "Retry sign-in",
      signOutLabel: "Sign out",
      signOutTitle: "Sign out of Claude?",
      idleLabel: "Sign in with the Anthropic account you use for Claude.",
      startingLabel: "Starting Claude sign-in.",
      verifyingLabel: "Checking the sign-in with Claude.",
      openLabel: "Open sign-in page",
      iconProvider: "claudeAgent",
    };
  }
  if (input.driver === "codex") {
    return {
      accountLabel: "ChatGPT account",
      signInLabel: "Sign in to Codex",
      retryLabel: "Retry sign-in",
      signOutLabel: "Sign out",
      signOutTitle: "Sign out of Codex?",
      idleLabel: "Sign in with the ChatGPT account you use for Codex.",
      startingLabel: "Starting Codex sign-in.",
      verifyingLabel: "Checking the sign-in with Codex.",
      openLabel: "Open sign-in page",
      iconProvider: "codex",
    };
  }

  const usesBrowser =
    input.authMethod === "oauth-personal" || input.authMethod === "oauth-business";
  return {
    accountLabel:
      ANTIGRAVITY_AUTH_METHODS.find((method) => method.value === input.authMethod)?.label ??
      "Google account",
    signInLabel: usesBrowser ? "Sign in with Google" : "Connect",
    retryLabel: usesBrowser ? "Retry Google sign-in" : "Retry connection",
    signOutLabel: usesBrowser ? "Sign out of Google" : "Disconnect",
    signOutTitle: usesBrowser ? "Sign out of Google?" : "Disconnect Antigravity?",
    idleLabel: usesBrowser
      ? "Sign in with the Google account you use for Antigravity."
      : "Connect with the credentials set in provider settings on web or desktop.",
    startingLabel: usesBrowser ? "Starting Google sign-in." : "Checking credentials.",
    verifyingLabel: usesBrowser ? "Checking Google sign-in." : "Checking credentials.",
    openLabel: "Open Google sign-in",
    iconProvider: "antigravity",
  };
}

/** Setup remains available when the provider has no selectable models. */
export function providerNeedsSetup(provider: ServerProvider): boolean {
  return (
    (provider.setup?.canAuthenticate === true || provider.setup?.canInstall === true) &&
    (!provider.enabled ||
      !provider.installed ||
      provider.auth.status !== "authenticated" ||
      provider.availability === "unavailable" ||
      provider.models.length === 0)
  );
}
