export function resolveAgentAwarenessPlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly subtitle: string | undefined;
} {
  return platform === "ios"
    ? { supported: true, subtitle: undefined }
    : { supported: false, subtitle: "iOS only" };
}

/**
 * On-device dictation ships for iOS and iPadOS only.
 *
 * The row stays visible on Android and says why, rather than disappearing: a
 * setting that exists on one device and not another is easier to understand
 * than one that is simply absent.
 */
export function resolveVoicePlatformPresentation(platform: string): {
  readonly supported: boolean;
  readonly value: string | undefined;
} {
  return platform === "ios"
    ? { supported: true, value: undefined }
    : { supported: false, value: "iOS only" };
}
