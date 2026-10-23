import { constrainDockPaneHeight } from "./layout";
import { deriveFileInspectorPaneLayout } from "./layout";
import { describe, expect, it } from "vite-plus/test";

import {
  alignListPaneToHinge,
  deriveLayout,
  resolveTerminalDockPosition,
  deriveThreadFeedInitialContentInset,
  deriveThreadWorkLogSizing,
  deriveWorkspaceDockPaneLayout,
  deriveWorkspacePaneLayout,
  isPrimarySidebarPinned,
} from "./layout";

describe("thread work-log text sizing", () => {
  it.each([
    { baseFontSize: 16, fontScale: 1.25, estimatedRowHeight: 28 },
    { baseFontSize: 22, fontScale: 2, estimatedRowHeight: 52 },
  ])(
    "measures accessibility text instead of locking it to the estimate: %j",
    ({ estimatedRowHeight, ...settings }) => {
      expect(deriveThreadWorkLogSizing(settings)).toMatchObject({
        estimatedRowHeight,
        fixedRowHeight: undefined,
      });
    },
  );

  it("invalidates native text measurements even when the minimum row height is unchanged", () => {
    const original = deriveThreadWorkLogSizing({ baseFontSize: 16, fontScale: 1 });
    for (const settings of [
      { baseFontSize: 16, fontScale: 1.1 },
      { baseFontSize: 17, fontScale: 1 },
    ]) {
      const resized = deriveThreadWorkLogSizing(settings);
      expect(resized.estimatedRowHeight).toBe(original.estimatedRowHeight);
      expect(resized.textSizeKey).not.toBe(original.textSizeKey);
    }
  });
});

describe("deriveThreadFeedInitialContentInset", () => {
  // regression: #5585 land the first thread open above the composer on Android
  it("does not double native iOS insets", () => {
    expect(
      deriveThreadFeedInitialContentInset({
        platform: "ios",
        usesNativeAutomaticInsets: true,
        bottomContentInset: 174,
      }),
    ).toBeUndefined();
  });
});

describe("isPrimarySidebarPinned", () => {
  // regression: #20406 sidebar toggle works on iPad and iPhone Duo
  it("keeps compact native roots pinned so search cannot hide the sidebar for a later split", () => {
    expect(
      isPrimarySidebarPinned({ pathname: "/", nativeWorkspace: true, usesSplitView: false }),
    ).toBe(true);
  });
});

describe("deriveWorkspacePaneLayout", () => {
  it("keeps an explicitly hidden thread sidebar hidden when the file inspector is visible", () => {
    const layout = deriveLayout({ width: 1_024, height: 1_366 });

    expect(
      deriveWorkspacePaneLayout({
        layout,
        viewportWidth: 1_024,
        primarySidebarPreferredVisible: false,
        auxiliaryPanePreferredVisible: true,
        auxiliaryPaneRole: "inspector",
      }),
    ).toMatchObject({
      primarySidebarVisible: false,
      primarySidebarSuppressedByAuxiliary: false,
      auxiliaryPaneVisible: true,
    });
  });
});

describe("terminal split layouts", () => {
  it.each([744, 768, 810])(
    "keeps chat and terminal visible on a %i-point portrait iPad",
    (width) => {
      const layout = deriveLayout({ width, height: 1080 });
      const side = deriveFileInspectorPaneLayout({ layout, viewportWidth: width });
      const bottom = deriveWorkspaceDockPaneLayout({ layout, viewportHeight: 1080 });
      expect(
        resolveTerminalDockPosition({
          preferredPosition: "right",
          sideSupported: side.supported,
          bottomSupported: bottom.supported,
        }),
      ).toBe("bottom");
    },
  );

  it("restores the side preference when a narrow iPad rotates to landscape", () => {
    const layout = deriveLayout({ width: 1080, height: 810 });
    const side = deriveFileInspectorPaneLayout({ layout, viewportWidth: 1080 });
    const bottom = deriveWorkspaceDockPaneLayout({ layout, viewportHeight: 810 });
    expect(
      resolveTerminalDockPosition({
        preferredPosition: "right",
        sideSupported: side.supported,
        bottomSupported: bottom.supported,
      }),
    ).toBe("right");
  });

  it("keeps phone terminals full screen", () => {
    const layout = deriveLayout({ width: 390, height: 844 });
    expect(
      resolveTerminalDockPosition({
        preferredPosition: "bottom",
        sideSupported: deriveFileInspectorPaneLayout({ layout, viewportWidth: 390 }).supported,
        bottomSupported: deriveWorkspaceDockPaneLayout({ layout, viewportHeight: 844 }).supported,
      }),
    ).toBeNull();
  });
});

describe("alignListPaneToHinge", () => {
  const layout = deriveLayout({ width: 852, height: 880 });

  it("keeps the default split when either side of the hinge would be too narrow", () => {
    const narrowList = {
      layout,
      hinge: { x: 300, width: 0 },
      viewportWidth: 852,
      leadingWidth: 96,
    };
    const narrowDetail = {
      layout,
      hinge: { x: 600, width: 0 },
      viewportWidth: 852,
      leadingWidth: 0,
    };
    expect(alignListPaneToHinge(narrowList)).toBe(layout);
    expect(alignListPaneToHinge(narrowDetail)).toBe(layout);
  });
});

it("keeps chat usable above a resized bottom dock", () => {
  expect(constrainDockPaneHeight({ preferredHeight: 400, availableHeight: 1_024 })).toBe(400);
  expect(constrainDockPaneHeight({ preferredHeight: 900, availableHeight: 1_024 })).toBe(704);
  expect(constrainDockPaneHeight({ preferredHeight: 40, availableHeight: 1_024 })).toBe(180);
});

it("offers a default dock height on a split-view window", () => {
  const layout = deriveLayout({ width: 1_024, height: 1_366 });

  expect(deriveWorkspaceDockPaneLayout({ layout, viewportHeight: 1_366 })).toEqual({
    supported: true,
    height: 519,
  });
});

it("does not dock in a compact shell or a short window", () => {
  expect(
    deriveWorkspaceDockPaneLayout({
      layout: deriveLayout({ width: 430, height: 932 }),
      viewportHeight: 932,
    }),
  ).toEqual({ supported: false, height: null });

  expect(
    deriveWorkspaceDockPaneLayout({
      layout: deriveLayout({ width: 1_024, height: 610 }),
      viewportHeight: 610,
    }),
  ).toEqual({ supported: false, height: null });
});
