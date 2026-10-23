import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ fixture: vi.fn<() => ReturnType<typeof setup>>() }));

vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const core = createRequire(import.meta.resolve("@react-navigation/native"))(
    "@react-navigation/core",
  );
  return { ...core, useNavigation: () => mocks.fixture().navigation };
});
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Pressable: "button",
  ScrollView: "scroll-view",
  View: "view",
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { dismiss: vi.fn() },
  KeyboardEvents: { addListener: () => ({ remove: vi.fn() }) },
  KeyboardStickyView: "sticky-view",
  useKeyboardState: () => ({ height: 0, isVisible: false }),
}));
vi.mock("expo-clipboard", () => ({ getStringAsync: vi.fn() }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/AppText", () => ({ AppText: "text" }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/ui/GlassSurface", () => ({ GlassSurface: "glass" }));
vi.mock("../../components/ui/IconButton", () => ({ IconButton: () => null }));
vi.mock("../../components/ui/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../../components/ui/Sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/ComposerToolbar", () => ({
  ComposerToolbarButton: () => null,
  ComposerToolbarRow: "toolbar-row",
  ComposerToolbarScroller: "toolbar-scroller",
}));
vi.mock("../../components/LoadingScreen", () => ({ LoadingScreen: () => null }));
vi.mock("../../native/native-layout-metrics", () => ({ useNativeColumnLayoutMetrics: () => null }));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: {} }));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => null },
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { authenticated: true, scopes: ["terminal:operate", "terminal:read"] },
    error: null,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/workspace", () => ({ useConnectionsReady: () => true }));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: "connected" } },
  }),
}));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => mocks.fixture().selection,
}));
vi.mock("../../state/use-thread-detail", () => ({ useSelectedThreadProjection: () => null }));
vi.mock("../../state/use-terminal-session", () => ({
  useKnownTerminalSessions: () => ({ sessions: [], isPending: false, error: null }),
  useAttachedTerminalSession: () => ({
    buffer: "first line\nsecond line\n",
    version: 1,
    status: "running",
    summary: null,
    error: null,
  }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  insertComposerDraftContext: (key: string, insertion: unknown) =>
    mocks.fixture().insertDraft(key, insertion),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "terminal-context" }));
vi.mock("../review/reviewDiffRendering", () => ({ REVIEW_MONO_FONT_FAMILY: "monospace" }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    isReady: true,
    appearance: { terminalFontSize: 14 },
    themeAppearance: "dark",
    themeId: "t3-code",
    themeVariables: {},
  }),
}));
vi.mock("../connection/EnvironmentConnectionNotice", () => ({
  EnvironmentConnectionNotice: () => null,
}));
vi.mock("./nativeTerminalModule", () => ({ hasNativeTerminalSurface: () => true }));
vi.mock("./NativeTerminalSurface", () => ({
  TerminalSurface: ({ onCapture }: { onCapture: (text: string) => void }) => (
    <button onClick={() => onCapture("first line\nsecond line\n")}>Capture output</button>
  ),
}));
vi.mock("./terminalDebugLog", () => ({ terminalDebugLog: vi.fn() }));
vi.mock("./terminalLaunchContext", () => ({
  takePendingTerminalLaunch: () => null,
  useInitialTerminalLaunchLocation: () => ({ cwd: "/workspace", worktreePath: null }),
}));
vi.mock("./useTerminalGridSync", () => ({ useTerminalGridSync: vi.fn() }));
vi.mock("./useTerminalLifecycle", () => ({ useTerminalLifecycle: vi.fn() }));

import { ThreadTerminalRouteScreen } from "./ThreadTerminalRouteScreen";

function setup(hasHistory: boolean, acceptsDraft = true) {
  const fixture = {
    selection: {
      selectedThread: {
        environmentId: EnvironmentId.make("environment"),
        id: ThreadId.make("thread"),
      },
      selectedThreadProject: { workspaceRoot: "/workspace", scripts: [] },
      selectedEnvironmentConnection: null,
    },
    navigation: {
      canGoBack: () => hasHistory,
      goBack: vi.fn(),
      dispatch: vi.fn(),
      setParams: vi.fn(),
      addListener: () => () => {},
      isFocused: () => true,
    },
    insertDraft: vi.fn((_key: string, _insertion: unknown) => acceptsDraft),
  };
  mocks.fixture.mockReturnValue(fixture);
  return fixture;
}

function press(renderer: ReactTestRenderer, label: string) {
  renderer.root
    .findAllByType("button")
    .find((button) => button.children.includes(label))!
    .props.onClick();
}

it.each([
  { hasHistory: false, acceptsDraft: true },
  { hasHistory: true, acceptsDraft: true },
  { hasHistory: false, acceptsDraft: false },
])(
  "attaches selected output (back history: $hasHistory, draft accepted: $acceptsDraft)",
  async ({ hasHistory, acceptsDraft }) => {
    const fixture = setup(hasHistory, acceptsDraft);
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ThreadTerminalRouteScreen
          route={{
            params: { environmentId: "environment", threadId: "thread", terminalId: "term-1" },
          }}
        />,
      );
    });
    try {
      await act(async () => press(renderer, "Capture output"));
      const secondLine = renderer.root
        .findAllByType("button")
        .find((line) => line.props.accessibilityLabel === "Line 2: second line")!;
      await act(async () => secondLine.props.onPress());
      await act(async () => press(renderer, "Attach selected output"));
      expect(fixture.insertDraft).toHaveBeenCalledWith("environment:thread", {
        text: expect.any(String),
        context: {
          version: 1,
          records: [
            expect.objectContaining({
              kind: "terminal",
              terminalId: "term-1",
              text: "second line",
              lineStart: 2,
              lineEnd: 2,
            }),
          ],
        },
      });
      if (!acceptsDraft) {
        expect(
          renderer.root
            .findAllByType("button")
            .some((button) => button.children.includes("Attach selected output")),
        ).toBe(true);
        expect(fixture.navigation.goBack).not.toHaveBeenCalled();
        expect(fixture.navigation.dispatch).not.toHaveBeenCalled();
        return;
      }
      expect(
        renderer.root
          .findAllByType("button")
          .some((button) => button.children.includes("Attach selected output")),
      ).toBe(false);
      if (hasHistory) {
        expect(fixture.navigation.goBack).toHaveBeenCalledExactlyOnceWith();
        expect(fixture.navigation.dispatch).not.toHaveBeenCalled();
      } else {
        expect(fixture.navigation.goBack).not.toHaveBeenCalled();
        expect(fixture.navigation.dispatch).toHaveBeenCalledExactlyOnceWith({
          type: "REPLACE",
          payload: { name: "Thread", params: { environmentId: "environment", threadId: "thread" } },
        });
      }
    } finally {
      await act(async () => renderer.unmount());
    }
  },
);
