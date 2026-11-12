import "~/index.css";

import type { DesktopPreviewFavicon, PreviewSessionSnapshot } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import type { RightPanelSurface } from "~/rightPanelStore";
import { act, render, stubGlobal, type Screen } from "../../test/render";

const setAudioMuted = vi.hoisted(() => vi.fn(async () => undefined));
const navigateHistory = vi.hoisted(() => vi.fn());

vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ theme: "light", resolvedTheme: "light", themeHalves: null }) as never,
}));
vi.mock(import("~/browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => ({ profiles: [] }) as never,
}));
vi.mock(import("./preview/previewBridge"), () => ({
  previewBridge: { setAudioMuted } as never,
}));
vi.mock("../navigationHistory", () => ({ canNavigateHistory: () => true, navigateHistory }));

import { HistorySwipeNavigation } from "./HistorySwipeNavigation";
import { RightPanelTabs } from "./RightPanelTabs";

// A real 1x1 PNG, so the browser keeps it instead of falling back on a decode error.
const PIXEL_A =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PIXEL_B =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const previewSurface = {
  id: "browser:tab-1" as const,
  kind: "preview" as const,
  resourceId: "tab-1",
};
const secondSurface = {
  id: "browser:tab-2" as const,
  kind: "preview" as const,
  resourceId: "tab-2",
};
const sessions: Readonly<Record<string, PreviewSessionSnapshot>> = {
  "tab-1": {
    threadId: "thread-1",
    tabId: "tab-1",
    navStatus: { _tag: "Success", url: "http://24x.xf.local/", title: "Local site" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-08-09T00:00:00.000Z",
  },
  "tab-2": {
    threadId: "thread-1",
    tabId: "tab-2",
    navStatus: { _tag: "Success", url: "http://24x.xf.local/admin", title: "Admin" },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-08-09T00:00:00.000Z",
  },
};

const favicon = (dataUrl: string, pageUrl: string): DesktopPreviewFavicon => ({
  dataUrl,
  pageUrl,
  capturedAt: 1,
});

function overlay(
  icon: DesktopPreviewFavicon | null,
  audio?: { audible?: boolean; audioMuted?: boolean },
) {
  return {
    hasWebContents: true,
    canGoBack: false,
    canGoForward: false,
    loading: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system" as const,
    audioMuted: audio?.audioMuted ?? false,
    audible: audio?.audible ?? false,
    controller: "none" as const,
    favicon: icon,
  };
}

const noop = () => undefined;

function setup() {
  setAudioMuted.mockClear();
}

function tabs(
  first: DesktopPreviewFavicon | null,
  second?: DesktopPreviewFavicon,
  audio?: { audible?: boolean; audioMuted?: boolean },
  previewRuntimeTabId: ((tabId: string) => string) | null = (tabId) => `runtime:${tabId}`,
) {
  return (
    <RightPanelTabs
      onAddIssues={noop}
      issuesAvailable={false}
      mode="inline"
      open
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      })}
      surfaces={second ? [previewSurface, secondSurface] : [previewSurface]}
      environmentId={null}
      activeSurfaceId={previewSurface.id}
      pendingSurfaceIds={new Set()}
      previewSessions={sessions}
      desktopByTabId={{
        "tab-1": overlay(first, audio),
        ...(second ? { "tab-2": overlay(second) } : {}),
      }}
      {...(previewRuntimeTabId ? { previewRuntimeTabId } : {})}
      terminalLabelsById={new Map()}
      onActivate={noop}
      onCloseSurface={noop}
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseAllSurfaces={noop}
      onCopyFilePath={noop}
      onAddBrowser={noop}
      onAddBrowserInProfile={noop}
      onAddTerminal={noop}
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddDiff={noop}
      onAddFiles={noop}
      onAddDevice={noop}
      browserAvailable
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable={false}
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
    >
      <div>content</div>
    </RightPanelTabs>
  );
}

const imageSources = (screen: Screen) =>
  [...screen.container.querySelectorAll("img")].map((image) => image.src);
const button = (screen: Screen, name: string) =>
  [...screen.container.querySelectorAll("button")].find((element) => element.ariaLabel === name);

describe("preview tab favicon", () => {
  it("prefers a live capture and never asks a public provider about a private hostname", async () => {
    await using screen = await render(tabs(favicon(PIXEL_A, "http://24x.xf.local/")));
    expect(imageSources(screen)).toEqual([PIXEL_A]);

    await screen.rerender(tabs(null));
    expect(imageSources(screen)).toEqual([]);
  });

  it("keeps route-specific captures isolated between live tabs on one origin", async () => {
    await using screen = await render(
      tabs(favicon(PIXEL_A, "http://24x.xf.local/"), favicon(PIXEL_B, "http://24x.xf.local/admin")),
    );
    expect(imageSources(screen)).toEqual([PIXEL_A, PIXEL_B]);
  });

  it("hides a capture while the server session still describes another origin", async () => {
    await using screen = await render(tabs(favicon(PIXEL_A, "https://example.com/")));
    expect(imageSources(screen)).not.toContain(PIXEL_A);
  });
});

describe("preview tab audio toggle", () => {
  it.each([
    { audible: false, audioMuted: false },
    { audible: false, audioMuted: true },
  ])("is absent for a silent tab (muted=$audioMuted)", async (audio) => {
    await using screen = await render(tabs(null, undefined, audio));
    expect(button(screen, "Mute Local site")).toBeUndefined();
    expect(button(screen, "Unmute Local site")).toBeUndefined();
  });

  it.each([
    { audioMuted: false, label: "Mute Local site", nextMuted: true },
    { audioMuted: true, label: "Unmute Local site", nextMuted: false },
  ])("$label addresses the desktop by runtime tab id", async ({ audioMuted, label, nextMuted }) => {
    setup();
    await using screen = await render(tabs(null, undefined, { audible: true, audioMuted }));
    await act(() => button(screen, label)!.click());
    expect(setAudioMuted).toHaveBeenCalledExactlyOnceWith("runtime:tab-1", nextMuted);
  });

  it("hides the toggle when no runtime tab id can be resolved", async () => {
    await using screen = await render(tabs(null, undefined, { audible: true }, null));
    expect(button(screen, "Mute Local site")).toBeUndefined();
  });
});

// Chromium starts a gesture scroll, and Electron reports its begin, only for a
// wheel event the page did not preventDefault; it then scrolls the latched scroller.
function trackpad() {
  const begin = new Set<() => void>();
  const end = new Set<() => void>();
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  let scrolling = false;
  return {
    bridge: { onTrackpadScrollBegin: subscribe(begin), onTrackpadScrollEnd: subscribe(end) },
    scroll(target: Element, deltas: readonly number[]) {
      let scroller: Element | null = target;
      while (
        scroller &&
        (scroller.scrollWidth <= scroller.clientWidth ||
          !/auto|scroll/.test(getComputedStyle(scroller).overflowX))
      ) {
        scroller = scroller.parentElement;
      }
      for (const deltaX of deltas) {
        const event = new WheelEvent("wheel", {
          deltaX,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        target.dispatchEvent(event);
        if (event.defaultPrevented) continue;
        if (scroller) scroller.scrollLeft += deltaX;
        if (scrolling) continue;
        scrolling = true;
        for (const listener of begin) listener();
      }
      if (scrolling) for (const listener of end) listener();
      scrolling = false;
    },
  };
}

const surfaces: RightPanelSurface[] = Array.from({ length: 16 }, (_, index) => ({
  id: `terminal:${index}`,
  kind: "terminal",
  resourceId: `${index}`,
  terminalIds: [`${index}`],
  activeTerminalId: `${index}`,
}));

describe("RightPanelTabs", () => {
  it("a flick that scrolls the tab strip to its left edge keeps the thread, a swipe from the edge goes back", async () => {
    navigateHistory.mockReset();
    const { bridge, scroll } = trackpad();
    using _bridge = stubGlobal("desktopBridge", bridge);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const panel = document.createElement("div");
    panel.style.cssText = "width: 320px; height: 200px; display: flex";
    await using screen = await render(
      <>
        <HistorySwipeNavigation />
        <RightPanelTabs
          onAddIssues={noop}
          issuesAvailable={false}
          mode="embedded"
          keybindings={[]}
          getShortcutContext={() => ({
            terminalFocus: false,
            terminalOpen: false,
            previewFocus: false,
            previewOpen: false,
            isWeb: true,
            isDesktop: false,
          })}
          surfaces={surfaces}
          environmentId={null}
          activeSurfaceId={null}
          pendingSurfaceIds={new Set()}
          previewSessions={{}}
          desktopByTabId={{}}
          terminalLabelsById={new Map(surfaces.map((surface) => [surface.id, "Terminal"]))}
          onActivate={noop}
          onCloseSurface={noop}
          onCloseOtherSurfaces={noop}
          onCloseSurfacesToRight={noop}
          onCloseAllSurfaces={noop}
          onCopyFilePath={noop}
          onAddBrowser={noop}
          onAddBrowserInProfile={noop}
          onAddTerminal={noop}
          onAddDiff={noop}
          onAddFiles={noop}
          onAddPullRequest={noop}
          onAddPullRequests={noop}
          onAddDevice={noop}
          browserAvailable={false}
          terminalAvailable
          diffAvailable={false}
          filesAvailable={false}
          pullRequestAvailable={false}
          pullRequestsAvailable={false}
          deviceAvailable={false}
        >
          {null}
        </RightPanelTabs>
      </>,
      { container: panel },
    );
    const viewport = screen.container.querySelector<HTMLElement>(
      '[data-right-panel-tab-list] [data-slot="scroll-area-viewport"]',
    )!;
    expect(viewport.scrollWidth - viewport.clientWidth).toBeGreaterThan(120);
    viewport.scrollLeft = 120;

    const momentum = Array.from({ length: 24 }, (_, index) => -60 * 0.85 ** index);
    scroll(viewport.querySelector("[data-active-tab]")!, [-10, -20, -30, ...momentum]);

    expect(viewport.scrollLeft).toBe(0);
    expect(navigateHistory).not.toHaveBeenCalled();

    viewport.scrollLeft = 0;
    scroll(viewport.querySelector("[data-active-tab]")!, [-40, -40, -40, -40, -40]);

    expect(navigateHistory).toHaveBeenCalledExactlyOnceWith("back");
  });
});
