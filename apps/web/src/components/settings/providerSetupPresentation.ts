import {
  ANTIGRAVITY_AUTH_METHODS,
  type AntigravityAuthMethod,
  type ProviderAuthState,
  type ProviderDriverKind,
} from "@t3tools/contracts";

/**
 * User-facing copy for one provider's setup panel.
 *
 * Sign-in reads differently per provider — Antigravity connects a Google
 * account, Claude an Anthropic one, Codex a ChatGPT one — and an API-key
 * method is not a sign-in at all. Keeping the strings in one descriptor is what
 * lets the panel itself stay driver-agnostic.
 */
export interface ProviderSetupPresentation {
  /** Section landmark label, e.g. "Claude setup". */
  readonly sectionLabel: string;
  /** Heading above the sign-in controls. */
  readonly methodLabel: string;
  readonly signInLabel: string;
  readonly retryLabel: string;
  readonly signOutLabel: string;
  /** Confirmation shown before signing out. */
  readonly signOutPrompt: (providerName: string, environmentLabel: string) => string;
  readonly authenticatedLabel: string;
  readonly phaseLabels: Record<ProviderAuthState["phase"], string>;
}

const ANTIGRAVITY_BROWSER_PHASES: ProviderSetupPresentation["phaseLabels"] = {
  idle: "Sign in with your Google account.",
  starting: "Starting Google sign-in.",
  waiting: "Waiting for Google sign-in.",
  verifying: "Checking Google sign-in and available models.",
  succeeded: "Google sign-in complete.",
  failed: "Google sign-in failed.",
  cancelled: "Google sign-in cancelled.",
};

/** API key methods skip the browser, so the phases read as a credential check. */
const ANTIGRAVITY_CREDENTIAL_PHASES: ProviderSetupPresentation["phaseLabels"] = {
  idle: "Connect with the credentials in the provider settings.",
  starting: "Checking credentials.",
  waiting: "Checking credentials.",
  verifying: "Checking credentials and available models.",
  succeeded: "Connected.",
  failed: "Could not connect with the configured credentials.",
  cancelled: "Connection cancelled.",
};

function cliPhaseLabels(
  providerLabel: string,
  accountLabel: string,
): ProviderSetupPresentation["phaseLabels"] {
  return {
    idle: `Sign in to ${accountLabel}.`,
    starting: `Starting ${providerLabel} sign-in.`,
    waiting: `Waiting for you to finish signing in.`,
    verifying: `Checking the sign-in with ${providerLabel}.`,
    succeeded: `Signed in to ${accountLabel}.`,
    failed: `${providerLabel} sign-in failed.`,
    cancelled: `${providerLabel} sign-in cancelled.`,
  };
}

function cliPresentation(input: {
  readonly providerLabel: string;
  readonly accountLabel: string;
  readonly accountNoun: string;
}): ProviderSetupPresentation {
  return {
    sectionLabel: `${input.providerLabel} setup`,
    methodLabel: input.accountNoun,
    signInLabel: `Sign in to ${input.providerLabel}`,
    retryLabel: "Retry sign-in",
    signOutLabel: "Sign out",
    signOutPrompt: (providerName, environmentLabel) =>
      `Sign out of ${input.accountNoun} for ${providerName} on ${environmentLabel}? This stops its running threads. Thread history is kept.`,
    authenticatedLabel: `Signed in to ${input.accountLabel}.`,
    phaseLabels: cliPhaseLabels(input.providerLabel, input.accountLabel),
  };
}

/** Read the configured Antigravity method from an instance config. */
export function readAntigravityAuthMethod(config: unknown): AntigravityAuthMethod {
  const value =
    config !== null && typeof config === "object" && "authMethod" in config
      ? config.authMethod
      : undefined;
  return (
    ANTIGRAVITY_AUTH_METHODS.find((method) => method.value === value)?.value ?? "oauth-personal"
  );
}

export function resolveProviderSetupPresentation(input: {
  readonly driver: ProviderDriverKind;
  readonly authMethod: AntigravityAuthMethod;
}): ProviderSetupPresentation {
  if (input.driver === "claudeAgent") {
    return cliPresentation({
      providerLabel: "Claude",
      accountLabel: "your Anthropic account",
      accountNoun: "Anthropic account",
    });
  }
  if (input.driver === "codex") {
    return cliPresentation({
      providerLabel: "Codex",
      accountLabel: "your ChatGPT account",
      accountNoun: "ChatGPT account",
    });
  }

  const usesBrowser =
    input.authMethod === "oauth-personal" || input.authMethod === "oauth-business";
  const methodLabel =
    ANTIGRAVITY_AUTH_METHODS.find((method) => method.value === input.authMethod)?.label ??
    "Google account";
  return {
    sectionLabel: "Antigravity setup",
    methodLabel,
    signInLabel: usesBrowser ? "Sign in with Google" : "Connect",
    retryLabel: usesBrowser ? "Retry Google sign-in" : "Retry connection",
    signOutLabel: usesBrowser ? "Sign out of Google" : "Disconnect",
    signOutPrompt: (providerName, environmentLabel) =>
      `${usesBrowser ? "Sign out of Google" : "Disconnect"} for ${providerName} on ${environmentLabel}? This stops its running threads. Thread history is kept.`,
    authenticatedLabel: usesBrowser ? "Signed in with Google." : "Connected.",
    phaseLabels: usesBrowser ? ANTIGRAVITY_BROWSER_PHASES : ANTIGRAVITY_CREDENTIAL_PHASES,
  };
}
