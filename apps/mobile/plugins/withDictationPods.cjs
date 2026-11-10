const fs = require("node:fs");
const path = require("node:path");

const { withDangerousMod } = require("expo/config-plugins");

// CocoaPods trunk stops at FluidAudio 0.7.8, so the pod comes from git, pinned to the v0.18.3 commit.
// It is declared here and not in `extraPods` because those are added to every target that links
// Expo modules, and the widget extension must not carry a speech model runtime.
const FLUID_AUDIO_COMMIT = "c8b41f98eae668794dd0083bbe028fe7e6585051";
const MARKER = "# pseudocode: on-device dictation runtime, app target only";
const APP_TARGET_MODULES = "  use_expo_modules!\n";
const POD = `  ${MARKER}
  pod 'FluidAudio', :git => 'https://github.com/FluidInference/FluidAudio.git', :commit => '${FLUID_AUDIO_COMMIT}'
`;

function addDictationPods(podfile) {
  if (podfile.includes(MARKER)) return podfile;
  const first = podfile.indexOf(APP_TARGET_MODULES);
  if (first === -1 || podfile.indexOf(APP_TARGET_MODULES, first + 1) !== -1) {
    throw new Error(
      "Unable to add the dictation pods: expected exactly one `use_expo_modules!` line in the Podfile.",
    );
  }
  const insertAt = first + APP_TARGET_MODULES.length;
  return podfile.slice(0, insertAt) + POD + podfile.slice(insertAt);
}

function withDictationPods(config) {
  return withDangerousMod(config, [
    "ios",
    (nextConfig) => {
      const podfilePath = path.join(nextConfig.modRequest.platformProjectRoot, "Podfile");
      fs.writeFileSync(podfilePath, addDictationPods(fs.readFileSync(podfilePath, "utf8")), "utf8");
      return nextConfig;
    },
  ]);
}

withDictationPods.addDictationPods = addDictationPods;
module.exports = withDictationPods;
