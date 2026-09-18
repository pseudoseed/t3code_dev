import { describe, expect, it } from "vite-plus/test";
import { BUILT_IN_THEMES, getThemeColorsForAppearance } from "@t3tools/shared/themePalettes";

import { getMobileThemeVariables, themeColorToNativeColor } from "../../lib/mobileTheme";

import { getMobileThemeRuntimeVariables } from "../../lib/mobileThemeVariables";

import { buildGhosttyThemeConfig, getMobileTerminalTheme } from "./terminalTheme";

describe("getMobileTerminalTheme", () => {
  it("preserves the default light terminal palette", () => {
    expect(getMobileTerminalTheme("t3-code", "light")).toMatchObject({
      background: "#f2f2f7",
      foreground: "#6C6C71",
      cursorForeground: "#009fff",
      cursorBackground: "#f2f2f7",
    });
  });

  it("preserves the default dark terminal palette", () => {
    expect(getMobileTerminalTheme("t3-code", "dark")).toMatchObject({
      background: "#0a0a0a",
      foreground: "#adadb1",
      cursorForeground: "#009fff",
      cursorBackground: "#0a0a0a",
    });
  });
  it("applies the selected palette without replacing ANSI status colors", () => {
    const standard = getMobileTerminalTheme("t3-code", "dark");
    const ocean = getMobileTerminalTheme("ocean", "dark");

    expect(ocean.background).not.toBe(standard.background);
    expect(ocean.cursorForeground).not.toBe(standard.cursorForeground);
    expect(ocean.palette[1]).toBe(standard.palette[1]);
    expect(ocean.palette[2]).toBe(standard.palette[2]);
    expect(ocean.palette[3]).toBe(standard.palette[3]);
    expect(ocean.palette[4]).toBe(getMobileThemeVariables("ocean", "dark")["--color-primary"]);
    expect(ocean.palette[6]).toBe(
      getMobileThemeVariables("ocean", "dark")["--color-foreground-muted"],
    );
    expect(ocean.palette[4]).not.toBe(standard.palette[4]);
  });

  it("uses the actual standard theme rather than the custom-theme fallback", () => {
    for (const scheme of ["light", "dark"] as const) {
      const colors = getMobileThemeRuntimeVariables("t3-code", scheme);
      const terminal = getMobileTerminalTheme("t3-code", scheme);
      expect(terminal.palette[4]).toBe(colors["--color-primary"]);
      expect(terminal.palette[6]).toBe(colors["--color-foreground-muted"]);
    }
  });

  it("honors resolved system accent overrides", () => {
    const colors = {
      ...getMobileThemeRuntimeVariables("material-you", "dark"),
      "--color-primary": "#abcdef",
    };
    const terminal = getMobileTerminalTheme("material-you", "dark", colors);
    expect(terminal.palette[4]).toBe("#abcdef");
    expect(terminal.palette[12]).toBe("#abcdef");
  });

  it("uses the canonical desktop terminal roles for built-in themes", () => {
    const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === "ocean")!;
    const colors = getThemeColorsForAppearance(theme, "dark")!;
    const terminal = getMobileTerminalTheme("ocean", "dark");

    expect(terminal.background).toBe(themeColorToNativeColor(colors.terminalBackground));
    expect(terminal.foreground).toBe(themeColorToNativeColor(colors.terminalForeground));
    expect(terminal.cursorForeground).toBe(themeColorToNativeColor(colors.terminalCursor));
  });
});

describe("buildGhosttyThemeConfig", () => {
  it("serializes theme colors into a ghostty config file", () => {
    const config = buildGhosttyThemeConfig(getMobileTerminalTheme("t3-code", "dark"));

    expect(config).toContain("background = #0a0a0a");
    expect(config).toContain("foreground = #adadb1");
    expect(config).toContain("cursor-color = #009fff");
    expect(config).toContain("palette = 0=#141415");
    expect(config).toContain("palette = 15=#c6c6c8");
    expect(config.endsWith("\n")).toBe(true);
  });
});
