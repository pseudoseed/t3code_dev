const fs = require("node:fs");
const path = require("node:path");

const { withDangerousMod } = require("expo/config-plugins");

const MARKER = "# t3code: give T3Voice a module map without an umbrella header";
const MODULE_MAP_REPAIR = `${MARKER}
    # React Native 0.88 builds every static pod with a SwiftPM dependency into the
    # shared products dir. ClerkExpo lands there too, and two module maps that each
    # declare an umbrella header in one directory fail with "Umbrella for module
    # 'ClerkExpo' already covers this directory". T3Voice is Swift only, so a plain
    # header is enough. CocoaPods rejects custom module maps for Swift static
    # libraries, so the generated one is rewritten here instead.
    t3voice_module_map = File.join(installer.sandbox.root.to_s, "Target Support Files", "T3Voice", "T3Voice.modulemap")
    if File.exist?(t3voice_module_map)
      File.write(t3voice_module_map, "module T3Voice {\\n  header \\"T3Voice-umbrella.h\\"\\n\\n  export *\\n}\\n")
    end
`;

module.exports = function withIosT3VoiceModuleMap(config) {
  return withDangerousMod(config, [
    "ios",
    (nextConfig) => {
      const podfilePath = path.join(nextConfig.modRequest.platformProjectRoot, "Podfile");
      const podfile = fs.readFileSync(podfilePath, "utf8");

      if (podfile.includes(MARKER)) {
        return nextConfig;
      }

      const postInstallStart = "post_install do |installer|\n";
      if (!podfile.includes(postInstallStart)) {
        throw new Error("Unable to repair the T3Voice module map: post_install is missing.");
      }

      fs.writeFileSync(
        podfilePath,
        podfile.replace(postInstallStart, `${postInstallStart}${MODULE_MAP_REPAIR}`),
        "utf8",
      );
      return nextConfig;
    },
  ]);
};
