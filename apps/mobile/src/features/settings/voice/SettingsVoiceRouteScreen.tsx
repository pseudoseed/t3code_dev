import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  DEFAULT_CLEANUP_PROMPT,
  MAX_CLEANUP_PROMPT_LENGTH,
  removeLearnedCorrection,
  type CorrectionPair,
} from "@t3tools/client-runtime/voice-input";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../../components/AndroidScreenHeader";
import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { DIARIZER_MODEL_ID } from "../../../native/t3Voice";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { SettingsSection } from "../components/SettingsSection";
import { SettingsSwitchRow } from "../components/SettingsSwitchRow";
import { useVoiceModels } from "./useVoiceModels";
import {
  formatModelSize,
  formatVoiceStorageUsage,
  resolveCleanupModelRows,
  resolveSpeakerFilteringPresentation,
  resolveSpeechModelRows,
  type VoiceModelRow,
} from "./voiceSettings";

export function SettingsVoiceRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : null;

  const models = useVoiceModels({
    selectedSpeechModelId: preferences?.voiceSpeechModelId ?? null,
    selectedCleanupModelId: preferences?.voiceCleanupModelId ?? null,
    allowsCellular: preferences?.voiceDownloadOnCellular ?? false,
  });

  const speakerFiltering = resolveSpeakerFilteringPresentation({
    selectedSpeechModelId: preferences?.voiceSpeechModelId ?? null,
    diarizerInstalled: models.diarizerInstalled,
    diarizerSizeText: formatModelSize(models.diarizerBytes),
  });

  const cleanupEnabled = preferences?.voiceCleanupEnabled ?? false;

  const confirmDelete = (row: VoiceModelRow) => {
    Alert.alert(
      `Delete ${row.label}?`,
      `This frees ${row.sizeText}. You can download it again later.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void models.removeModel(row.id);
          },
        },
      ],
    );
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Voice" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Speech model">
          {resolveSpeechModelRows(models.snapshot).map((row, index) => (
            <ModelRow
              key={row.id}
              row={row}
              first={index === 0}
              onSelect={() => savePreferences({ voiceSpeechModelId: row.id })}
              onDownload={() => void models.startDownload(row.id)}
              onCancel={models.cancelDownload}
              onDelete={() => confirmDelete(row)}
            />
          ))}
        </SettingsSection>
        <Footnote>
          Everything here runs on this iPhone or iPad. No audio and no text leaves the device.
        </Footnote>

        <SettingsSection title="Other voices">
          <SettingsSwitchRow
            icon="person.2"
            label="Ignore other voices"
            subtitle={speakerFiltering.subtitle}
            disabled={!speakerFiltering.enabled}
            value={speakerFiltering.enabled && (preferences?.voiceSpeakerFilteringEnabled ?? false)}
            onValueChange={(value) => savePreferences({ voiceSpeakerFilteringEnabled: value })}
          />
          {speakerFiltering.needsDiarizer ? (
            <ActionRow
              label={
                models.snapshot.download?.modelId === DIARIZER_MODEL_ID
                  ? "Downloading voice separation"
                  : "Download voice separation"
              }
              value={formatModelSize(models.diarizerBytes)}
              busy={models.snapshot.download?.modelId === DIARIZER_MODEL_ID}
              onPress={() => void models.startDownload(DIARIZER_MODEL_ID)}
            />
          ) : null}
        </SettingsSection>

        <SettingsSection title="Cleanup">
          <SettingsSwitchRow
            icon="wand.and.stars"
            label="Clean up transcripts"
            subtitle="Rewrites what you said into written text, on this device."
            value={cleanupEnabled}
            onValueChange={(value) => savePreferences({ voiceCleanupEnabled: value })}
          />
        </SettingsSection>

        {cleanupEnabled ? (
          <>
            <SettingsSection title="Cleanup model">
              {resolveCleanupModelRows(models.snapshot).map((row, index) => (
                <ModelRow
                  key={row.id}
                  row={row}
                  first={index === 0}
                  onSelect={() => savePreferences({ voiceCleanupModelId: row.id })}
                  onDownload={() => void models.startDownload(row.id)}
                  onCancel={models.cancelDownload}
                  onDelete={() => confirmDelete(row)}
                />
              ))}
            </SettingsSection>

            <PromptEditor
              value={preferences?.voiceCleanupPrompt ?? DEFAULT_CLEANUP_PROMPT}
              onChange={(value) => savePreferences({ voiceCleanupPrompt: value })}
              onReset={() => savePreferences({ voiceCleanupPrompt: DEFAULT_CLEANUP_PROMPT })}
            />

            <TextListEditor
              title="Preferred spellings"
              hint="One per line. These are kept exactly as you write them."
              placeholder={"Ghostty\nT3 Code"}
              value={preferences?.voiceCleanupPreferredSpellings ?? ""}
              onChange={(value) => savePreferences({ voiceCleanupPreferredSpellings: value })}
            />

            <TextListEditor
              title="Corrections"
              hint="One per line, as wrong -> right."
              placeholder={"tea three -> T3\nghosty -> Ghostty"}
              value={preferences?.voiceCleanupCorrections ?? ""}
              onChange={(value) => savePreferences({ voiceCleanupCorrections: value })}
            />

            <LearnedCorrections
              pairs={preferences?.voiceLearnedCorrections ?? []}
              onDelete={(wrong) =>
                savePreferences({
                  voiceLearnedCorrections: removeLearnedCorrection(
                    preferences?.voiceLearnedCorrections ?? [],
                    wrong,
                  ),
                })
              }
            />
          </>
        ) : null}

        <SettingsSection title="Storage">
          <ValueRow
            label="Downloaded models"
            value={formatVoiceStorageUsage(models.storageBytes)}
          />
          <SettingsSwitchRow
            icon="antenna.radiowaves.left.and.right"
            label="Download over cellular"
            subtitle="Models are large. Off means downloads wait for Wi-Fi."
            value={preferences?.voiceDownloadOnCellular ?? false}
            onValueChange={(value) => savePreferences({ voiceDownloadOnCellular: value })}
          />
        </SettingsSection>
        <Footnote>
          Clearing the app cache never deletes these. Delete a model here to free its space.
        </Footnote>
      </ScrollView>
    </View>
  );
}

function Footnote(props: { readonly children: string }) {
  return (
    <Text className="px-2 pb-1 text-sm leading-normal text-foreground-muted">{props.children}</Text>
  );
}

function ValueRow(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="flex-row items-center gap-4 p-4">
      <Text className="min-w-0 flex-1 text-lg text-foreground">{props.label}</Text>
      <Text className="text-base text-foreground-muted">{props.value}</Text>
    </View>
  );
}

function ActionRow(props: {
  readonly label: string;
  readonly value?: string;
  readonly busy?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.busy}
      onPress={props.onPress}
      className="flex-row items-center gap-4 border-t border-border-subtle p-4"
    >
      <Text className="min-w-0 flex-1 text-lg text-accent-foreground">{props.label}</Text>
      {props.busy ? <ActivityIndicator size="small" /> : null}
      {props.value ? <Text className="text-base text-foreground-muted">{props.value}</Text> : null}
    </Pressable>
  );
}

/**
 * One model, in whatever state it is in.
 *
 * A model this device cannot run stays visible and disabled with the reason on
 * it. Hiding it would leave the user wondering where an option they read about
 * went.
 */
function ModelRow(props: {
  readonly row: VoiceModelRow;
  readonly first: boolean;
  readonly onSelect: () => void;
  readonly onDownload: () => void;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
}) {
  const { row } = props;
  const disabled = row.state.kind === "unavailable" || row.state.kind === "downloading";

  const onPress = () => {
    switch (row.state.kind) {
      case "downloadable":
      case "failed":
        props.onDownload();
        return;
      case "installed":
        props.onSelect();
        return;
      default:
    }
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: row.state.kind === "selected" }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={row.canDelete ? props.onDelete : undefined}
      className={
        props.first
          ? "flex-row items-center gap-4 p-4"
          : "flex-row items-center gap-4 border-t border-border-subtle p-4"
      }
    >
      <View className={disabled ? "min-w-0 flex-1 gap-1 opacity-[0.45]" : "min-w-0 flex-1 gap-1"}>
        <Text className="text-lg text-foreground">{row.label}</Text>
        <Text className="text-sm leading-normal text-foreground-muted">{describeRow(row)}</Text>
      </View>
      <ModelRowAccessory row={row} onCancel={props.onCancel} onDelete={props.onDelete} />
    </Pressable>
  );
}

function describeRow(row: VoiceModelRow): string {
  switch (row.state.kind) {
    case "unavailable":
      return `${row.detail} — ${row.state.reason}`;
    case "downloadable":
      return `${row.detail} — ${row.sizeText} download`;
    case "downloading":
      return row.state.fraction === null
        ? `${row.detail} — downloading`
        : `${row.detail} — ${Math.round(row.state.fraction * 100)}%`;
    case "failed":
      return `${row.detail} — ${row.state.message}`;
    default:
      return row.detail;
  }
}

function ModelRowAccessory(props: {
  readonly row: VoiceModelRow;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
}) {
  switch (props.row.state.kind) {
    case "downloading":
      return (
        <Pressable accessibilityLabel="Cancel download" onPress={props.onCancel}>
          <SymbolView
            name="xmark.circle.fill"
            size={20}
            tintColorClassName={"accent-chevron"}
            type="monochrome"
            weight="semibold"
          />
        </Pressable>
      );
    case "selected":
      return (
        <SymbolView
          name="checkmark"
          size={18}
          tintColorClassName={"accent-icon"}
          type="monochrome"
          weight="semibold"
        />
      );
    case "failed":
    case "downloadable":
      return (
        <SymbolView
          name="arrow.down.circle"
          size={20}
          tintColorClassName={"accent-icon"}
          type="monochrome"
          weight="regular"
        />
      );
    case "installed":
      return props.row.canDelete ? (
        <Pressable accessibilityLabel={`Delete ${props.row.label}`} onPress={props.onDelete}>
          <SymbolView
            name="trash"
            size={18}
            tintColorClassName={"accent-chevron"}
            type="monochrome"
            weight="regular"
          />
        </Pressable>
      ) : null;
    default:
      return null;
  }
}

/**
 * Mappings picked up from words the user fixed after a dictation.
 *
 * Every one is listed and deletable. Nothing is learned that the user cannot
 * see and undo, because a wrong mapping otherwise silently rewrites every
 * transcript from then on.
 */
function LearnedCorrections(props: {
  readonly pairs: readonly CorrectionPair[];
  readonly onDelete: (wrong: string) => void;
}) {
  return (
    <SettingsSection title="Learned from your edits">
      {props.pairs.length === 0 ? (
        <View className="p-4">
          <Text className="text-sm leading-normal text-foreground-muted">
            When you fix a word that voice input got wrong, the fix is remembered here.
          </Text>
        </View>
      ) : (
        props.pairs.map((pair, index) => (
          <View
            key={pair.wrong}
            className={
              index === 0
                ? "flex-row items-center gap-4 p-4"
                : "flex-row items-center gap-4 border-t border-border-subtle p-4"
            }
          >
            <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
              {pair.wrong} → {pair.right}
            </Text>
            <Pressable
              accessibilityLabel={`Forget ${pair.wrong}`}
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => props.onDelete(pair.wrong)}
            >
              <SymbolView
                name="trash"
                size={18}
                tintColorClassName={"accent-chevron"}
                type="monochrome"
                weight="regular"
              />
            </Pressable>
          </View>
        ))
      )}
    </SettingsSection>
  );
}

function PromptEditor(props: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onReset: () => void;
}) {
  const [draft, setDraft] = useState(props.value);

  return (
    <SettingsSection title="Cleanup instructions">
      <View className="gap-3 p-4">
        <TextInput
          multiline
          autoCapitalize="sentences"
          maxLength={MAX_CLEANUP_PROMPT_LENGTH}
          value={draft}
          onChangeText={setDraft}
          onBlur={() => props.onChange(draft)}
          className="min-h-[140px] rounded-[14px] border border-input-border bg-input px-4 py-3.5 text-base leading-normal text-foreground"
        />
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setDraft(DEFAULT_CLEANUP_PROMPT);
            props.onReset();
          }}
        >
          <Text className="text-base text-accent-foreground">Reset to default</Text>
        </Pressable>
      </View>
    </SettingsSection>
  );
}

function TextListEditor(props: {
  readonly title: string;
  readonly hint: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);

  return (
    <SettingsSection title={props.title}>
      <View className="gap-2 p-4">
        <TextInput
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={props.placeholder}
          value={draft}
          onChangeText={setDraft}
          onBlur={() => props.onChange(draft)}
          className="min-h-[92px] rounded-[14px] border border-input-border bg-input px-4 py-3.5 text-base leading-normal text-foreground"
        />
        <Text className="text-sm leading-normal text-foreground-muted">{props.hint}</Text>
      </View>
    </SettingsSection>
  );
}
