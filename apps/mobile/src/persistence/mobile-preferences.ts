import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { SidebarProjectGroupingMode } from "@t3tools/contracts";
import {
  MAX_CLEANUP_PROMPT_LENGTH,
  MAX_LEARNED_CORRECTIONS,
} from "@t3tools/client-runtime/voice-input";
import { MOBILE_THEME_IDS, type MobileThemeId, type MobileThemeMode } from "../lib/mobileTheme";

import * as MobileDatabase from "./mobile-database";
import * as MobileSecureStorage from "./mobile-secure-storage";
import { MobileStorageDecodeError, MobileStorageEncodeError } from "./mobile-storage";

/**
 * Voice text is capped on the way in.
 *
 * These live in the one preferences blob, which is read-modify-written whole on
 * every save. Bounded values are fine there; an unbounded one would make every
 * unrelated preference write more expensive over time.
 */
const MAX_VOICE_CORRECTION_TEXT_LENGTH = 8_000;
/** Five minutes of speech, with room to spare. */
const MAX_VOICE_PENDING_TRANSCRIPT_LENGTH = 20_000;

const PREFERENCES_KEY = "t3code.preferences";
const PREFERENCES_FALLBACK_KEY = "t3code.preferences.fallback";

export interface Preferences {
  readonly liveActivitiesEnabled?: boolean;
  readonly themeId?: MobileThemeId;
  readonly lightThemeId?: MobileThemeId;
  readonly darkThemeId?: MobileThemeId;
  readonly themeMode?: MobileThemeMode;
  readonly baseFontSize?: number;
  readonly terminalFontSize?: number | null;
  readonly markdownFontSize?: number;
  readonly codeFontSize?: number | null;
  readonly codeWordBreak?: boolean;
  readonly connectOnboardingOptOutAccounts?: ReadonlyArray<string>;
  readonly collapsedProjectGroups?: readonly string[];
  /** @deprecated Kept temporarily so older OTA bundles retain the selected mode. */
  readonly projectGroupingEnabled?: boolean;
  readonly projectGroupingMode?: SidebarProjectGroupingMode;
  /**
   * Device-local mirror of the web `legacySidebarEnabled` setting. Mobile has
   * no client-settings sync, so the legacy grouped thread list is opted into
   * per device. Deliberately a fresh key (was `threadListV2Enabled`, an
   * opt-out): sanitizing drops the old key, so every device resets to the
   * default flat list — see `resolveThreadListV2Enabled`.
   */
  readonly legacyThreadListEnabled?: boolean;
  /** Device-local counterpart of desktop's `planModeEnabled` legacy flag. */
  readonly planModeEnabled?: boolean;
  /** Fresh keys reset both shelves to collapsed when users update. */
  readonly threadListSettledShelfExpanded?: boolean;
  readonly threadListSnoozedShelfExpanded?: boolean;
  /**
   * Groups the sidebar thread list into per-project sections. Device-local
   * mirror of the web `sidebarProjectSectionsEnabled` client setting.
   * Undefined keeps sections on, matching the web default.
   */
  readonly sidebarProjectSectionsEnabled?: boolean;
  /** Project keys whose sidebar section is folded. Only meaningful with
      `sidebarProjectSectionsEnabled`; the legacy list has its own key. */
  readonly collapsedSidebarProjectSections?: readonly string[];
  /** Where the workspace terminal pane sits on regular-width layouts. */
  readonly terminalPaneDockPosition?: "right" | "bottom";
  /**
   * On-device dictation, all device-scoped rather than environment-scoped: the
   * model runs on this phone no matter which environment the composer is
   * attached to.
   */
  readonly voiceSpeechModelId?: string;
  /** Only honoured by models whose backend can tell voices apart. */
  readonly voiceSpeakerFilteringEnabled?: boolean;
  /** Off keeps multi-hundred-megabyte downloads off a metered connection. */
  readonly voiceDownloadOnCellular?: boolean;
  readonly voiceCleanupEnabled?: boolean;
  readonly voiceCleanupModelId?: string;
  /** Undefined means the shipped default prompt, which can change per release. */
  readonly voiceCleanupPrompt?: string;
  /** Raw editor text, parsed into hints at prompt-build time. */
  readonly voiceCleanupPreferredSpellings?: string;
  readonly voiceCleanupCorrections?: string;
  /**
   * Mappings the learning loop picked up from words the user fixed by hand.
   *
   * Capped, oldest dropped first, and every entry is listed and deletable in
   * voice settings. Nothing is learned that the user cannot see and undo.
   */
  readonly voiceLearnedCorrections?: ReadonlyArray<{
    readonly wrong: string;
    readonly right: string;
  }>;
  /**
   * A transcript written down before cleanup started and not yet committed.
   *
   * Only present when the process died between the two, which is the one
   * failure that raises no error to catch. The next launch offers it back into
   * the draft it belongs to, or discards it if that draft has moved on.
   */
  readonly voicePendingTranscript?: {
    readonly ownerKey: string;
    readonly revision: number;
    readonly text: string;
    readonly capturedAt: number;
  };
}

export class MobilePreferencesLoadError extends Schema.TaggedErrorClass<MobilePreferencesLoadError>()(
  "MobilePreferencesLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to load mobile preferences.";
  }
}

export class MobilePreferencesSaveError extends Schema.TaggedErrorClass<MobilePreferencesSaveError>()(
  "MobilePreferencesSaveError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to save mobile preferences.";
  }
}

interface PreferencesFallback {
  readonly payload: string;
  readonly updatedAt: number;
  readonly preferences: Preferences;
}

export class MobilePreferencesStore extends Context.Service<
  MobilePreferencesStore,
  {
    readonly load: Effect.Effect<Preferences, MobilePreferencesLoadError>;
    readonly savePatch: (
      patch: Partial<Preferences>,
    ) => Effect.Effect<Preferences, MobilePreferencesSaveError>;
    readonly update: (
      transform: (current: Preferences) => Partial<Preferences>,
    ) => Effect.Effect<Preferences, MobilePreferencesSaveError>;
  }
>()("@t3tools/mobile/persistence/MobilePreferencesStore") {}

function sanitizePreferences(parsed: Preferences): Preferences {
  const preferences: {
    liveActivitiesEnabled?: boolean;
    themeId?: MobileThemeId;
    lightThemeId?: MobileThemeId;
    darkThemeId?: MobileThemeId;
    themeMode?: MobileThemeMode;
    baseFontSize?: number;
    terminalFontSize?: number | null;
    markdownFontSize?: number;
    codeFontSize?: number | null;
    codeWordBreak?: boolean;
    connectOnboardingOptOutAccounts?: ReadonlyArray<string>;
    collapsedProjectGroups?: readonly string[];
    projectGroupingEnabled?: boolean;
    projectGroupingMode?: SidebarProjectGroupingMode;
    legacyThreadListEnabled?: boolean;
    planModeEnabled?: boolean;
    threadListSettledShelfExpanded?: boolean;
    threadListSnoozedShelfExpanded?: boolean;
    sidebarProjectSectionsEnabled?: boolean;
    collapsedSidebarProjectSections?: readonly string[];
    terminalPaneDockPosition?: "right" | "bottom";
    voiceSpeechModelId?: string;
    voiceSpeakerFilteringEnabled?: boolean;
    voiceDownloadOnCellular?: boolean;
    voiceCleanupEnabled?: boolean;
    voiceCleanupModelId?: string;
    voiceCleanupPrompt?: string;
    voiceCleanupPreferredSpellings?: string;
    voiceCleanupCorrections?: string;
    voiceLearnedCorrections?: ReadonlyArray<{ readonly wrong: string; readonly right: string }>;
    voicePendingTranscript?: {
      readonly ownerKey: string;
      readonly revision: number;
      readonly text: string;
      readonly capturedAt: number;
    };
  } = {};

  if (typeof parsed.liveActivitiesEnabled === "boolean") {
    preferences.liveActivitiesEnabled = parsed.liveActivitiesEnabled;
  }
  if (
    typeof parsed.themeId === "string" &&
    (MOBILE_THEME_IDS as readonly string[]).includes(parsed.themeId)
  ) {
    preferences.themeId = parsed.themeId as MobileThemeId;
  }
  if (
    typeof parsed.lightThemeId === "string" &&
    (MOBILE_THEME_IDS as readonly string[]).includes(parsed.lightThemeId)
  ) {
    preferences.lightThemeId = parsed.lightThemeId as MobileThemeId;
  }
  if (
    typeof parsed.darkThemeId === "string" &&
    (MOBILE_THEME_IDS as readonly string[]).includes(parsed.darkThemeId)
  ) {
    preferences.darkThemeId = parsed.darkThemeId as MobileThemeId;
  }
  if (
    parsed.themeMode === "system" ||
    parsed.themeMode === "light" ||
    parsed.themeMode === "dark"
  ) {
    preferences.themeMode = parsed.themeMode;
  }
  if (typeof parsed.baseFontSize === "number") preferences.baseFontSize = parsed.baseFontSize;
  if (typeof parsed.terminalFontSize === "number" || parsed.terminalFontSize === null) {
    preferences.terminalFontSize = parsed.terminalFontSize;
  }
  if (typeof parsed.markdownFontSize === "number") {
    preferences.markdownFontSize = parsed.markdownFontSize;
  }
  if (typeof parsed.codeFontSize === "number" || parsed.codeFontSize === null) {
    preferences.codeFontSize = parsed.codeFontSize;
  }
  if (typeof parsed.codeWordBreak === "boolean") preferences.codeWordBreak = parsed.codeWordBreak;
  if (Array.isArray(parsed.connectOnboardingOptOutAccounts)) {
    preferences.connectOnboardingOptOutAccounts = parsed.connectOnboardingOptOutAccounts.filter(
      (account): account is string => typeof account === "string",
    );
  }
  if (Array.isArray(parsed.collapsedProjectGroups)) {
    preferences.collapsedProjectGroups = parsed.collapsedProjectGroups.filter(
      (key): key is string => typeof key === "string",
    );
  }
  if (typeof parsed.projectGroupingEnabled === "boolean") {
    preferences.projectGroupingEnabled = parsed.projectGroupingEnabled;
  }
  if (
    parsed.projectGroupingMode === "repository" ||
    parsed.projectGroupingMode === "repository_path" ||
    parsed.projectGroupingMode === "separate"
  ) {
    preferences.projectGroupingMode = parsed.projectGroupingMode;
  }
  if (typeof parsed.legacyThreadListEnabled === "boolean") {
    preferences.legacyThreadListEnabled = parsed.legacyThreadListEnabled;
  }
  if (typeof parsed.planModeEnabled === "boolean") {
    preferences.planModeEnabled = parsed.planModeEnabled;
  }
  if (typeof parsed.threadListSettledShelfExpanded === "boolean") {
    preferences.threadListSettledShelfExpanded = parsed.threadListSettledShelfExpanded;
  }
  if (typeof parsed.threadListSnoozedShelfExpanded === "boolean") {
    preferences.threadListSnoozedShelfExpanded = parsed.threadListSnoozedShelfExpanded;
  }
  if (typeof parsed.sidebarProjectSectionsEnabled === "boolean") {
    preferences.sidebarProjectSectionsEnabled = parsed.sidebarProjectSectionsEnabled;
  }
  if (Array.isArray(parsed.collapsedSidebarProjectSections)) {
    preferences.collapsedSidebarProjectSections = parsed.collapsedSidebarProjectSections.filter(
      (key): key is string => typeof key === "string",
    );
  }
  if (parsed.terminalPaneDockPosition === "right" || parsed.terminalPaneDockPosition === "bottom") {
    preferences.terminalPaneDockPosition = parsed.terminalPaneDockPosition;
  }
  if (typeof parsed.voiceSpeechModelId === "string") {
    preferences.voiceSpeechModelId = parsed.voiceSpeechModelId;
  }
  if (typeof parsed.voiceSpeakerFilteringEnabled === "boolean") {
    preferences.voiceSpeakerFilteringEnabled = parsed.voiceSpeakerFilteringEnabled;
  }
  if (typeof parsed.voiceDownloadOnCellular === "boolean") {
    preferences.voiceDownloadOnCellular = parsed.voiceDownloadOnCellular;
  }
  if (typeof parsed.voiceCleanupEnabled === "boolean") {
    preferences.voiceCleanupEnabled = parsed.voiceCleanupEnabled;
  }
  if (typeof parsed.voiceCleanupModelId === "string") {
    preferences.voiceCleanupModelId = parsed.voiceCleanupModelId;
  }
  if (typeof parsed.voiceCleanupPrompt === "string") {
    preferences.voiceCleanupPrompt = parsed.voiceCleanupPrompt.slice(0, MAX_CLEANUP_PROMPT_LENGTH);
  }
  if (typeof parsed.voiceCleanupPreferredSpellings === "string") {
    preferences.voiceCleanupPreferredSpellings = parsed.voiceCleanupPreferredSpellings.slice(
      0,
      MAX_VOICE_CORRECTION_TEXT_LENGTH,
    );
  }
  if (typeof parsed.voiceCleanupCorrections === "string") {
    preferences.voiceCleanupCorrections = parsed.voiceCleanupCorrections.slice(
      0,
      MAX_VOICE_CORRECTION_TEXT_LENGTH,
    );
  }
  if (Array.isArray(parsed.voiceLearnedCorrections)) {
    preferences.voiceLearnedCorrections = parsed.voiceLearnedCorrections
      .filter(
        (pair): pair is { wrong: string; right: string } =>
          typeof pair === "object" &&
          pair !== null &&
          typeof (pair as { wrong?: unknown }).wrong === "string" &&
          typeof (pair as { right?: unknown }).right === "string",
      )
      .slice(-MAX_LEARNED_CORRECTIONS);
  }
  const pendingTranscript = parsed.voicePendingTranscript;
  if (
    typeof pendingTranscript === "object" &&
    pendingTranscript !== null &&
    typeof pendingTranscript.ownerKey === "string" &&
    typeof pendingTranscript.revision === "number" &&
    typeof pendingTranscript.text === "string" &&
    typeof pendingTranscript.capturedAt === "number"
  ) {
    preferences.voicePendingTranscript = {
      ownerKey: pendingTranscript.ownerKey,
      revision: pendingTranscript.revision,
      text: pendingTranscript.text.slice(0, MAX_VOICE_PENDING_TRANSCRIPT_LENGTH),
      capturedAt: pendingTranscript.capturedAt,
    };
  }
  return preferences;
}

export const make = Effect.fn("MobilePreferencesStore.make")(function* () {
  const database = yield* MobileDatabase.MobileDatabase;
  const secureStorage = yield* MobileSecureStorage.MobileSecureStorage;
  const lock = yield* Semaphore.make(1);
  const lastUpdatedAt = yield* Ref.make(0);

  const parsePayload = (raw: string | null): Preferences | null => {
    if (raw === null || !raw.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key: PREFERENCES_KEY, cause }),
      );
      return null;
    }
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Preferences)
      : null;
  };

  const parseFallback = (raw: string | null): PreferencesFallback | null => {
    if (raw === null || !raw.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      console.warn(
        "[mobile-storage] ignored invalid JSON",
        new MobileStorageDecodeError({ key: PREFERENCES_FALLBACK_KEY, cause }),
      );
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("payload" in parsed) ||
      typeof parsed.payload !== "string" ||
      !("updatedAt" in parsed) ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    const preferences = parsePayload(parsed.payload);
    return preferences === null
      ? null
      : { payload: parsed.payload, updatedAt: parsed.updatedAt, preferences };
  };

  const encode = Effect.fn("MobilePreferencesStore.encode")(function* (
    key: string,
    value: unknown,
  ) {
    return yield* Effect.try({
      try: () => JSON.stringify(value),
      catch: (cause) => new MobileStorageEncodeError({ key, cause }),
    });
  });

  const nextUpdatedAt = Ref.modify(lastUpdatedAt, (last) => {
    const next = Math.max(Date.now(), last + 1);
    return [next, next] as const;
  });

  const saveJson = Effect.fn("MobilePreferencesStore.saveJson")(function* (
    payload: string,
    updatedAt?: number,
  ) {
    const timestamp = updatedAt ?? (yield* nextUpdatedAt);
    yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, timestamp));
    const databaseResult = yield* Effect.result(database.savePreferencesJson(payload, timestamp));
    if (databaseResult._tag === "Failure") {
      yield* Effect.logWarning("Database unavailable; saving preferences to secure storage.").pipe(
        Effect.annotateLogs({ cause: databaseResult.failure }),
      );
      const fallback = yield* encode(PREFERENCES_FALLBACK_KEY, { payload, updatedAt: timestamp });
      yield* secureStorage.setItem(PREFERENCES_FALLBACK_KEY, fallback);
      return;
    }
    yield* secureStorage
      .removeItem(PREFERENCES_FALLBACK_KEY)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not remove the mobile preferences fallback.").pipe(
            Effect.annotateLogs({ error }),
          ),
        ),
      );
  });

  const loadUnlocked = Effect.gen(function* () {
    const databaseResult = yield* Effect.result(database.loadPreferencesJson);
    const databaseAvailable = databaseResult._tag === "Success";
    const storedJson = databaseAvailable
      ? databaseResult.success
      : Option.none<MobileDatabase.StoredPreferencesJson>();
    if (databaseResult._tag === "Failure") {
      yield* Effect.logWarning("Database unavailable; loading fallback preferences.").pipe(
        Effect.annotateLogs({ cause: databaseResult.failure }),
      );
    }

    const fallbackResult = yield* Effect.result(secureStorage.getItem(PREFERENCES_FALLBACK_KEY));
    let fallbackJson: string | null = null;
    if (fallbackResult._tag === "Success") {
      fallbackJson = fallbackResult.success;
    } else if (Option.isNone(storedJson)) {
      return yield* fallbackResult.failure;
    } else {
      yield* Effect.logWarning("Could not inspect the mobile preferences fallback.").pipe(
        Effect.annotateLogs({ error: fallbackResult.failure }),
      );
    }

    const fallback = parseFallback(fallbackJson);
    const storedPreferences = Option.isSome(storedJson)
      ? parsePayload(storedJson.value.payload)
      : null;
    const fallbackIsNewer =
      fallback !== null &&
      (storedPreferences === null ||
        (Option.isSome(storedJson) && fallback.updatedAt > storedJson.value.updatedAt));

    let parsed: Preferences | null = null;
    if (fallbackIsNewer) {
      parsed = fallback.preferences;
      yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, fallback.updatedAt));
      if (databaseAvailable) yield* saveJson(fallback.payload, fallback.updatedAt);
    } else if (storedPreferences !== null && Option.isSome(storedJson)) {
      parsed = storedPreferences;
      yield* Ref.update(lastUpdatedAt, (last) => Math.max(last, storedJson.value.updatedAt));
      if (fallbackJson !== null) {
        yield* secureStorage
          .removeItem(PREFERENCES_FALLBACK_KEY)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not remove a stale mobile preferences fallback.").pipe(
                Effect.annotateLogs({ error }),
              ),
            ),
          );
      }
    }

    if (parsed === null) {
      const legacyJson = yield* secureStorage.getItem(PREFERENCES_KEY);
      const legacyPreferences = parsePayload(legacyJson);
      parsed = legacyPreferences;
      if (legacyJson !== null && legacyPreferences !== null && databaseAvailable) {
        yield* saveJson(legacyJson);
        yield* secureStorage
          .removeItem(PREFERENCES_KEY)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not remove migrated mobile preferences.").pipe(
                Effect.annotateLogs({ error }),
              ),
            ),
          );
      }
    }

    return parsed === null ? {} : sanitizePreferences(parsed);
  });

  const load = lock
    .withPermits(1)(loadUnlocked)
    .pipe(Effect.mapError((cause) => new MobilePreferencesLoadError({ cause })));

  const update = Effect.fn("MobilePreferencesStore.update")((transform) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* loadUnlocked;
          const patch = yield* Effect.try({
            try: () => transform(current),
            catch: (cause) => new MobilePreferencesSaveError({ cause }),
          });
          const next: Preferences = { ...current, ...patch };
          const payload = yield* encode(PREFERENCES_KEY, next);
          yield* saveJson(payload);
          return next;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof MobilePreferencesSaveError
            ? cause
            : new MobilePreferencesSaveError({ cause }),
        ),
      ),
  );

  return MobilePreferencesStore.of({
    load,
    update,
    savePatch: (patch) => update(() => patch),
  });
});

export const layer = Layer.effect(MobilePreferencesStore, make());
