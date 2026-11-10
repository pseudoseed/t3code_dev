import { expect, it } from "vite-plus/test";

import plugin from "./withDictationPods.cjs";

const { addDictationPods } = plugin;

const PODFILE = `platform :ios, '18.0'

target 'PseudoCode' do
  use_expo_modules!

  use_react_native!(:path => config[:reactNativePath])
end

target "ExpoWidgetsTarget" do
  use_expo_modules_widgets!
end
`;

it("adds FluidAudio to the app target and leaves the widget target alone", () => {
  const result: string = addDictationPods(PODFILE);
  const lines = result.split("\n");
  const pod = lines.findIndex((line) => line.includes("pod 'FluidAudio'"));

  expect(lines[pod]).toMatch(
    /^ {2}pod 'FluidAudio', :git => 'https:\/\/github\.com\/FluidInference\/FluidAudio\.git', :commit => '[0-9a-f]{40}'$/,
  );
  expect(pod).toBeGreaterThan(lines.indexOf("target 'PseudoCode' do"));
  expect(pod).toBeLessThan(lines.indexOf("end"));
  expect(result.replace(/^.*(pseudocode: on-device|pod 'FluidAudio').*\n/gm, "")).toBe(PODFILE);
});

it("changes nothing on a Podfile it already changed", () => {
  const once = addDictationPods(PODFILE);
  expect(addDictationPods(once)).toBe(once);
});

it.each([
  ["no app target line", PODFILE.replace("  use_expo_modules!\n", "")],
  [
    "two app target lines",
    PODFILE.replace("  use_expo_modules!\n", "  use_expo_modules!\n  use_expo_modules!\n"),
  ],
])("fails the prebuild on a Podfile with %s", (_name, podfile) => {
  expect(() => addDictationPods(podfile)).toThrow("expected exactly one `use_expo_modules!` line");
});
