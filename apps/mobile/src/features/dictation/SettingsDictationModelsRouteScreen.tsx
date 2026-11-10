import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { SettingsSection } from "../settings/components/SettingsSection";
import { localVoiceTranscriberAtom } from "../voice-input/VoiceInputProvider";
import { useAppleDictationAvailable } from "./appleDictation";
import { nativeErrorMessage, type DictationDownloads } from "./dictationDownloads";
import {
  DICTATION_PROCESSING,
  deviceCanRun,
  formatMegabytes,
  LOCAL_DICTATION_MODELS,
  recommendedDictationModel,
  type LocalDictationModel,
} from "./dictationModels";
import { dictationNative, type DictationNativeModule } from "./dictationNative";
import {
  currentDictationSettings,
  deviceLocale,
  dictationDownloads,
  updateDictationSettings,
  useDictationState,
} from "./dictationRuntime";
import {
  DictationSettingsPage,
  DictationUnavailable,
  DownloadRow,
  Footnote,
} from "./DictationSettingsPage";
import { describeRun } from "./runSummary";

const TITLE = "Dictation model";

type SampleResult =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "done"; readonly text: string }
  | { readonly status: "failed"; readonly message: string };

export function SettingsDictationModelsRouteScreen() {
  const downloads = dictationDownloads();
  if (dictationNative === null || downloads === null) return <DictationUnavailable title={TITLE} />;
  return <DictationModels native={dictationNative} downloads={downloads} />;
}

function DictationModels(props: {
  readonly native: DictationNativeModule;
  readonly downloads: DictationDownloads;
}) {
  const { native, downloads } = props;
  const snapshot = useSyncExternalStore(downloads.subscribe, downloads.getSnapshot);
  const { settings, lastRun } = useDictationState();
  const transcriber = useAtomValue(localVoiceTranscriberAtom);
  const appleMissing = useAppleDictationAvailable() === false;
  const [device] = useState(() => native.deviceInfo());
  const [sample, setSample] = useState<SampleResult>({ status: "idle" });
  const suggested = recommendedDictationModel({
    physicalMemoryBytes: device.physicalMemoryBytes,
    locale: deviceLocale(),
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- install state lives in native storage and is read when the page opens
  useEffect(() => {
    void downloads.refresh();
  }, [downloads]);

  const describe = (model: LocalDictationModel) =>
    model.id === suggested ? `${model.summary} Suggested for this device.` : model.summary;
  const installed = LOCAL_DICTATION_MODELS.filter(
    (model) => snapshot[model.id].status?.installed === true,
  );
  const missing = LOCAL_DICTATION_MODELS.filter(
    (model) => snapshot[model.id].status?.installed === false,
  );

  const download = (model: LocalDictationModel) => {
    const chosen = settings.modelId;
    void downloads.download(model.id).then((ready) => {
      // A model the user picked while this one downloaded stays picked.
      if (ready && currentDictationSettings().modelId === chosen) {
        updateDictationSettings({ modelId: model.id });
      }
    });
  };

  const confirmDelete = (model: LocalDictationModel) =>
    Alert.alert(
      `Delete ${model.name}?`,
      "The model is removed from this device. You can download it again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            if (settings.modelId === model.id) {
              const other = installed.find((candidate) => candidate.id !== model.id);
              updateDictationSettings({ modelId: appleMissing && other ? other.id : "apple" });
            }
            void downloads.remove(model.id);
          },
        },
      ],
    );

  const transcribeSample = async () => {
    const uri = native.sampleClipUri();
    if (uri === null || transcriber === null || transcriber === "checking") {
      setSample({ status: "failed", message: "Dictation is not available right now." });
      return;
    }
    setSample({ status: "running" });
    const { signal } = new AbortController();
    try {
      // Loaded first so the sample runs on the chosen model, not on the stand-in for a cold one.
      if (installed.some((model) => model.id === settings.modelId)) {
        await native.prepare(settings.modelId, DICTATION_PROCESSING);
      }
      const prepared = await transcriber.prepare({ signal });
      setSample({ status: "done", text: await prepared.transcribe(uri, { signal }) });
    } catch (error) {
      setSample({
        status: "failed",
        message: nativeErrorMessage(error, "The sample could not be transcribed."),
      });
    }
  };

  return (
    <DictationSettingsPage title={TITLE}>
      <SettingsSection title="Use for dictation">
        <ListChoiceRow
          label="Apple"
          description={
            appleMissing ? "Not available on this device." : "Built into iOS. Nothing to download."
          }
          disabled={appleMissing}
          selected={settings.modelId === "apple" && !appleMissing}
          onPress={() => updateDictationSettings({ modelId: "apple" })}
        />
        {installed.map((model) => (
          <ListChoiceRow
            key={model.id}
            separated
            label={model.name}
            description={describe(model)}
            selected={settings.modelId === model.id}
            onPress={() => updateDictationSettings({ modelId: model.id })}
          />
        ))}
      </SettingsSection>

      {missing.length === 0 ? null : (
        <SettingsSection title="Download">
          {missing.map((model, index) => (
            <View
              key={model.id}
              className={index > 0 ? "border-t border-border-subtle" : undefined}
            >
              {deviceCanRun(model, device.physicalMemoryBytes) ? (
                <DownloadRow
                  name={model.name}
                  description={`${describe(model)} ${formatMegabytes(model.downloadBytes)}.`}
                  state={snapshot[model.id]}
                  onDownload={() => download(model)}
                  onCancel={() => downloads.cancel(model.id)}
                />
              ) : (
                <ListRowLayout
                  disabled
                  icon="arrow.down.circle"
                  label={model.name}
                  description={`${model.summary} Needs more memory than this device has.`}
                />
              )}
            </View>
          ))}
        </SettingsSection>
      )}

      <SettingsSection title="Try it">
        <ListActionRow
          icon="play"
          label="Transcribe a sample"
          description="Runs a built-in recording through the model in use."
          loading={sample.status === "running"}
          onPress={() => void transcribeSample()}
        />
        {sample.status === "done" ? (
          <View className="gap-1 border-t border-border-subtle px-4 py-3">
            <Text className="text-base text-foreground">{sample.text}</Text>
            {lastRun === null ? null : (
              <Text className="text-sm text-foreground-muted">{describeRun(lastRun)}</Text>
            )}
          </View>
        ) : null}
        {sample.status === "failed" ? (
          <Text className="border-t border-border-subtle px-4 py-3 text-sm text-danger-foreground">
            {sample.message}
          </Text>
        ) : null}
      </SettingsSection>

      {installed.length === 0 ? null : (
        <SettingsSection title="Storage">
          {installed.map((model, index) => (
            <View
              key={model.id}
              className={index > 0 ? "border-t border-border-subtle" : undefined}
            >
              <ListActionRow
                icon="trash"
                tone="danger"
                label={`Delete ${model.name}`}
                detail={formatMegabytes(snapshot[model.id].status?.sizeOnDiskBytes ?? 0)}
                onPress={() => confirmDelete(model)}
              />
              {snapshot[model.id].error === null ? null : (
                <Text className="px-4 pb-3 text-sm text-danger-foreground">
                  {snapshot[model.id].error}
                </Text>
              )}
            </View>
          ))}
        </SettingsSection>
      )}

      <Footnote>
        Downloaded models run on this device, and recordings never leave it. Parakeet models are by
        NVIDIA and moondream (CC BY 4.0), converted by Fluid Inference.
      </Footnote>
    </DictationSettingsPage>
  );
}
