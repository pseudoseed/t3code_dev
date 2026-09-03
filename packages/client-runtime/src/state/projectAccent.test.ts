import { describe, expect, it } from "vite-plus/test";

import { projectAccent, projectAccentHue } from "./projectAccent.ts";

describe("projectAccentHue", () => {
  it("returns the same hue for the same key", () => {
    expect(projectAccentHue("env-1:proj-a")).toBe(projectAccentHue("env-1:proj-a"));
  });

  it("spreads a realistic set of project keys across several hues", () => {
    const keys = Array.from({ length: 24 }, (_, index) => `env-1:project-${index}`);
    const hues = new Set(keys.map(projectAccentHue));
    expect(hues.size).toBeGreaterThanOrEqual(6);
  });

  it("keeps the empty key on a real hue instead of falling off the palette", () => {
    expect(Number.isFinite(projectAccentHue(""))).toBe(true);
  });
});

describe("projectAccent", () => {
  it("uses one hue for both schemes", () => {
    const accent = projectAccent("env-1:proj-a");
    expect(accent.light.hue).toBe(accent.hue);
    expect(accent.dark.hue).toBe(accent.hue);
  });

  it("emits css colors both schemes can consume", () => {
    const accent = projectAccent("env-1:proj-a");
    for (const colors of [accent.light, accent.dark]) {
      expect(colors.text).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
      expect(colors.line).toMatch(/^hsl\(\d+ \d+% \d+% \/ [\d.]+\)$/);
      expect(colors.tint).toMatch(/^hsl\(\d+ \d+% \d+% \/ [\d.]+\)$/);
    }
  });
});
