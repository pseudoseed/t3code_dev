import { afterEach, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("loads project contracts and validates monograms without a native Intl.Segmenter", async () => {
  const descriptors = Object.getOwnPropertyDescriptors(Intl);
  Reflect.deleteProperty(descriptors, "Segmenter");
  vi.stubGlobal("Intl", Object.create(Object.getPrototypeOf(Intl), descriptors));
  vi.resetModules();

  expect(Intl.Segmenter).toBeUndefined();
  await import("./polyfills");

  const { ProjectMonogramText } = await import("@t3tools/contracts");
  const { is } = await import("effect/Schema");
  const isMonogram = is(ProjectMonogramText);

  for (const text of ["A", "T3", "É", "文書", "कि", "किखि", "e\u0301"]) {
    expect(isMonogram(text), text).toBe(true);
  }
  for (const text of ["", "ABC", "किखिगि", "\u0301", "A B", "🚀"]) {
    expect(isMonogram(text), text).toBe(false);
  }
});
