import { createNativeStackScreen } from "@react-navigation/native-stack";

import type { AppScreenOptions } from "../../native/glass-header-options";
import { SettingsDictationCorrectionsRouteScreen } from "./SettingsDictationCorrectionsRouteScreen";
import { SettingsDictationModelsRouteScreen } from "./SettingsDictationModelsRouteScreen";
import { SettingsDictationVoiceRouteScreen } from "./SettingsDictationVoiceRouteScreen";

/** The fork's dictation pages, opened from Settings > Microphone. */
export function dictationSettingsScreens(options: AppScreenOptions) {
  return {
    SettingsDictationModels: createNativeStackScreen({
      screen: SettingsDictationModelsRouteScreen,
      linking: "settings/microphone/model",
      options: { ...options, title: "Dictation model" },
    }),
    SettingsDictationVoice: createNativeStackScreen({
      screen: SettingsDictationVoiceRouteScreen,
      linking: "settings/microphone/voice",
      options: { ...options, title: "Only my voice" },
    }),
    SettingsDictationCorrections: createNativeStackScreen({
      screen: SettingsDictationCorrectionsRouteScreen,
      linking: "settings/microphone/corrections",
      options: { ...options, title: "Corrections" },
    }),
  };
}
