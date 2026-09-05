/**
 * Fork-local ANSI palette for the Ghostty surface.
 *
 * Upstream only hands Ghostty a foreground, background, and cursor color, so
 * every SGR color falls through to libghostty's built-in palette, which is
 * tuned for a dark background. On a light app theme that renders `\e[97m` and
 * friends as white-on-white. This module builds the full 256-entry default
 * palette the terminal is initialized with, picking a light or dark base set
 * from the terminal background's luminance.
 *
 * Kept out of the upstream terminal files on purpose: the only edits it forces
 * are the optional `palette` field on `GhosttyTheme` and one call site, so
 * upstream merges stay cheap.
 */
import type { GhosttyColor } from "../ghostty/core";

/** Number of entries libghostty expects for GHOSTTY_TERMINAL_OPT_COLOR_PALETTE. */
export const GHOSTTY_PALETTE_SIZE = 256;

/**
 * GitHub Light's terminal set. Colors 7 and 15 are deliberately grays rather
 * than white: foreground use of `\e[37m`/`\e[97m` is far more common than
 * background use, and white-on-white is the failure this palette exists to fix.
 */
const LIGHT_BASE_HEX = [
  "#24292f",
  "#cf222e",
  "#116329",
  "#9a6700",
  "#0969da",
  "#8250df",
  "#1b7c83",
  "#57606a",
  "#6e7781",
  "#a40e26",
  "#1a7f37",
  "#7d4e00",
  "#218bff",
  "#a475f9",
  "#3192aa",
  "#7d868f",
] as const;

/**
 * GitHub Dark's terminal set, so both schemes share one hue family. Color 0 is
 * lifted off GitHub's `#484f58` because our darkest theme background makes that
 * value read as empty space.
 */
const DARK_BASE_HEX = [
  "#5a626c",
  "#ff7b72",
  "#3fb950",
  "#d29922",
  "#58a6ff",
  "#bc8cff",
  "#39c5cf",
  "#b1bac4",
  "#6e7681",
  "#ffa198",
  "#56d364",
  "#e3b341",
  "#79c0ff",
  "#d2a8ff",
  "#56d4dd",
  "#f0f6fc",
] as const;

function hexColor(hex: string): GhosttyColor {
  const value = Number.parseInt(hex.slice(1), 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

const LIGHT_BASE = LIGHT_BASE_HEX.map(hexColor);
const DARK_BASE = DARK_BASE_HEX.map(hexColor);

/** xterm's 6x6x6 color cube (indices 16-231) plus its 24-step gray ramp. */
const CUBE_AND_GRAYS: readonly GhosttyColor[] = (() => {
  const levels = [0, 95, 135, 175, 215, 255];
  const colors: GhosttyColor[] = [];
  for (let r = 0; r < 6; r += 1) {
    for (let g = 0; g < 6; g += 1) {
      for (let b = 0; b < 6; b += 1) {
        colors.push({ r: levels[r]!, g: levels[g]!, b: levels[b]! });
      }
    }
  }
  for (let step = 0; step < 24; step += 1) {
    const value = 8 + step * 10;
    colors.push({ r: value, g: value, b: value });
  }
  return colors;
})();

/** WCAG relative luminance, used only to choose between the two base sets. */
export function terminalColorIsLight(color: GhosttyColor): boolean {
  const channel = (value: number) => {
    const srgb = value / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b) > 0.4;
}

/**
 * The 16 base colors for a background, before per-theme CSS overrides.
 * Exported for tests and for surfaces that only need the ANSI 16.
 */
export function terminalAnsiBaseColors(background: GhosttyColor): readonly GhosttyColor[] {
  return terminalColorIsLight(background) ? LIGHT_BASE : DARK_BASE;
}

/**
 * Builds the 256-entry palette Ghostty is initialized with.
 *
 * `overrides` lets a theme replace individual ANSI slots (index 0-15). Passing
 * a sparse array is fine; empty slots keep the scheme default.
 */
export function terminalAnsiPalette(
  background: GhosttyColor,
  overrides?: readonly (GhosttyColor | null | undefined)[],
): readonly GhosttyColor[] {
  const base = terminalAnsiBaseColors(background);
  const palette: GhosttyColor[] = Array.from({ length: GHOSTTY_PALETTE_SIZE });
  for (let index = 0; index < 16; index += 1) {
    palette[index] = overrides?.[index] ?? base[index]!;
  }
  for (let index = 16; index < GHOSTTY_PALETTE_SIZE; index += 1) {
    palette[index] = CUBE_AND_GRAYS[index - 16]!;
  }
  return palette;
}

let overrideProbe: CanvasRenderingContext2D | null | undefined;

/** Resolves any CSS color string to RGB, or null when it is absent or clear. */
function probeColor(value: string): GhosttyColor | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (typeof document === "undefined") return null;
  if (overrideProbe === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    overrideProbe = canvas.getContext("2d", { willReadFrequently: true });
  }
  const context = overrideProbe;
  if (!context) return null;
  context.clearRect(0, 0, 1, 1);
  // An unparseable value leaves fillStyle untouched, so the cleared pixel keeps
  // alpha 0 and we fall back rather than painting whatever color came before.
  context.fillStyle = "rgba(0, 0, 0, 0)";
  context.fillStyle = trimmed;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
  if (!alpha) return null;
  return { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
}

/**
 * The palette for the live document, honoring `--terminal-ansi-0` through
 * `--terminal-ansi-15` when a theme defines them. Called on mount and on theme
 * changes only, never per frame.
 */
export function terminalAnsiPaletteFromApp(background: GhosttyColor): readonly GhosttyColor[] {
  if (typeof document === "undefined") return terminalAnsiPalette(background);
  const styles = getComputedStyle(document.documentElement);
  const overrides: (GhosttyColor | null)[] = Array.from({ length: 16 }, () => null);
  let hasOverride = false;
  for (let index = 0; index < 16; index += 1) {
    const parsed = probeColor(styles.getPropertyValue(`--terminal-ansi-${index}`));
    if (parsed) {
      overrides[index] = parsed;
      hasOverride = true;
    }
  }
  return terminalAnsiPalette(background, hasOverride ? overrides : undefined);
}

/**
 * Band and accent colors for OSC 133 prompt rows.
 *
 * Deliberately faint: the point is to make the eye find where one command
 * begins, not to compete with the program's own colors. Themes can override
 * with `--terminal-prompt-background` and `--terminal-prompt-accent`.
 */
export function terminalPromptColors(background: GhosttyColor): {
  readonly promptBackground: string;
  readonly promptAccent: string;
} {
  const light = terminalColorIsLight(background);
  const fallbackBand = light ? "rgba(9, 105, 218, 0.05)" : "rgba(88, 166, 255, 0.07)";
  const fallbackAccent = light ? "rgba(9, 105, 218, 0.55)" : "rgba(88, 166, 255, 0.55)";
  if (typeof document === "undefined") {
    return { promptBackground: fallbackBand, promptAccent: fallbackAccent };
  }
  const styles = getComputedStyle(document.documentElement);
  const band = styles.getPropertyValue("--terminal-prompt-background").trim();
  const accent = styles.getPropertyValue("--terminal-prompt-accent").trim();
  return {
    promptBackground: band.length > 0 ? band : fallbackBand,
    promptAccent: accent.length > 0 ? accent : fallbackAccent,
  };
}
