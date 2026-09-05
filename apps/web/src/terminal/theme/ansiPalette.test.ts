import { describe, expect, it } from "vite-plus/test";

import {
  GHOSTTY_PALETTE_SIZE,
  terminalAnsiBaseColors,
  terminalAnsiPalette,
  terminalColorIsLight,
} from "./ansiPalette";

const WHITE = { r: 255, g: 255, b: 255 };
const NEAR_WHITE = { r: 252, g: 252, b: 252 };
const NEAR_BLACK = { r: 10, g: 10, b: 10 };

function contrast(a: { r: number; g: number; b: number }, b: typeof a): number {
  const luminance = (color: typeof a) => {
    const channel = (value: number) => {
      const srgb = value / 255;
      return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

describe("terminalColorIsLight", () => {
  it("classifies the app's light and dark terminal backgrounds", () => {
    expect(terminalColorIsLight(NEAR_WHITE)).toBe(true);
    expect(terminalColorIsLight(NEAR_BLACK)).toBe(false);
  });
});

describe("terminalAnsiPalette", () => {
  it("fills all 256 entries with the xterm cube and gray ramp above index 15", () => {
    const palette = terminalAnsiPalette(NEAR_BLACK);
    expect(palette).toHaveLength(GHOSTTY_PALETTE_SIZE);
    // 16 is the cube origin, 231 its far corner, 232/255 bound the gray ramp.
    expect(palette[16]).toEqual({ r: 0, g: 0, b: 0 });
    expect(palette[231]).toEqual({ r: 255, g: 255, b: 255 });
    expect(palette[232]).toEqual({ r: 8, g: 8, b: 8 });
    expect(palette[255]).toEqual({ r: 238, g: 238, b: 238 });
  });

  it("keeps every ANSI color legible on the backgrounds it was chosen for", () => {
    // Slots 0 and 15 are the palette's endpoints and always sit near one
    // background or the other, so they only have to stay distinguishable. Every
    // other slot carries real text and gets the 3:1 floor for large text. The
    // bug this guards is white-on-white.
    const backgrounds = [NEAR_WHITE, WHITE, NEAR_BLACK, { r: 28, g: 33, b: 40 }];
    for (const background of backgrounds) {
      for (const [index, color] of terminalAnsiBaseColors(background).entries()) {
        const floor = index === 0 || index === 15 ? 2 : 3;
        expect(
          contrast(color, background),
          `ansi ${index} on rgb(${background.r},${background.g},${background.b})`,
        ).toBeGreaterThan(floor);
      }
    }
  });

  it("applies sparse overrides without disturbing other slots", () => {
    const base = terminalAnsiPalette(NEAR_BLACK);
    const overrides: ({ r: number; g: number; b: number } | null)[] = Array.from(
      { length: 16 },
      () => null,
    );
    overrides[1] = { r: 1, g: 2, b: 3 };
    const palette = terminalAnsiPalette(NEAR_BLACK, overrides);
    expect(palette[1]).toEqual({ r: 1, g: 2, b: 3 });
    expect(palette[2]).toEqual(base[2]);
    expect(palette[200]).toEqual(base[200]);
  });
});
