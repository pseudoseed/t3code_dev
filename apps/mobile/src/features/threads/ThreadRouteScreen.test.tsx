import { act, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ fixture: vi.fn<() => ReturnType<typeof setup>>() }));

// Use React Navigation's real focus subscription without loading its native container.
vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.resolve("@react-navigation/native"))("@react-navigation/core");
});
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  ScrollView: "scroll-view",
  View: "view",
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "test-id" }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/ui/AppBar", () => ({ AppBar: () => null }));
vi.mock("../../components/ui/EmptyState", () => ({ EmptyState: () => null }));
vi.mock("../../components/LoadingScreen", () => ({ LoadingScreen: () => null }));
vi.mock("../../components/RenderErrorBoundary", () => ({
  RenderErrorBoundary: ({ children }: { children: ReactNode }) => children,
  RenderFailureView: () => null,
}));
vi.mock("../../native/NativeInspectorContent", () => ({
  NativeInspectorContent: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => vi.fn() }));
vi.mock("../../native/native-glass", () => ({ NATIVE_LIQUID_GLASS_SUPPORTED: false }));
vi.mock("../../state/workspace", () => ({ useConnectionsReady: () => true }));
vi.mock("../../state/shell", () => ({ useEnvironmentShellReadiness: () => ({ status: "ready" }) }));
vi.mock("../../state/threads", () => ({ threadEnvironment: {} }));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/use-vcs-action-state", () => ({
  useGitActionProgress: () => null,
  dismissGitActionResult: vi.fn(),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({ connectionState: "connected" }),
  useRemoteEnvironmentRuntime: () => ({ connectionState: "connected" }),
  useRemoteConnections: () => ({ onReconnectEnvironment: vi.fn() }),
}));
vi.mock("../../state/use-terminal-session", () => ({ useKnownTerminalSessions: () => [] }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("../../state/use-thread-detail", () => ({
  useSelectedThreadDetailState: () => ({
    data: Option.none(),
    error: Option.none(),
    status: "ready",
    history: { hasMoreHistory: false, error: null },
  }),
}));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => mocks.fixture().selection,
}));
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/workspace" }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({}),
}));
vi.mock("../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({}),
}));
vi.mock("../../state/use-selected-thread-requests", () => ({
  useSelectedThreadRequests: () => ({}),
}));
vi.mock("../../state/use-thread-composer-state", () => ({
  useThreadComposerState: () => ({
    selectedThreadFeed: [],
    selectedThreadQueuedMessages: [],
    selectedThreadQueueCount: 0,
    activeWorkStartedAt: null,
  }),
}));
vi.mock("../../state/recover-failed-thread-draft", () => ({ recoverFailedThreadDraft: vi.fn() }));
vi.mock("../../state/pending-thread-creation", () => ({
  clearPendingThreadCreationOutcome: vi.fn(),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));
vi.mock("../keyboard/hardwareKeyboardCommands", () => ({ useHardwareKeyboardCommand: vi.fn() }));
vi.mock("../workspace/useAndroidWorkspaceNavigation", () => ({
  useAndroidWorkspaceBack: vi.fn(),
  useWorkspaceBackNavigation: () => vi.fn(),
}));
vi.mock("../prompt-links/useThreadPromptLink", () => ({ useThreadPromptLink: vi.fn() }));
vi.mock("./use-worktree-setup", () => ({
  useWorktreeSetup: () => ({ snapshot: null, visible: null }),
}));
vi.mock("./NewTaskDraftRouteScreen", () => ({ NewTaskDraftRouteScreen: () => null }));
vi.mock("./GitActionProgressOverlay", () => ({ GitActionProgressOverlay: () => null }));
vi.mock("./git/GitOverviewSheet", () => ({ GitOverviewSheet: () => <span>Git</span> }));
vi.mock("../files/thread-file-navigator-pane", () => ({
  ThreadFileNavigatorPane: () => <span>Workspace files</span>,
}));
vi.mock("./ThreadScreenHost", () => ({
  ThreadScreenHost: ({ children }: { children: ReactNode }) => children,
  ThreadScreenFallback: ({ children }: { children: ReactNode }) => children,
  ThreadScreenBinding: ({ header }: { header: ReactNode }) => header,
}));
vi.mock("./ThreadHeader", () => ({
  ThreadHeader: ({
    gitControls,
    onOpenFilesInspector,
  }: {
    gitControls: {
      onOpenNewTerminal: () => void;
      onOpenTerminal: (terminalId?: string | null) => void;
    };
    onOpenFilesInspector: () => void;
  }) => (
    <>
      <button onClick={gitControls.onOpenNewTerminal}>Open new terminal</button>
      <button onClick={() => gitControls.onOpenTerminal("terminal-existing")}>Open terminal</button>
      <button onClick={onOpenFilesInspector}>Files</button>
    </>
  ),
}));
vi.mock("../terminal/terminalDebugLog", () => ({ terminalDebugLog: vi.fn() }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => mocks.fixture().layout,
  useAdaptiveWorkspacePaneRole: vi.fn(),
  useRegisterWorkspaceInspector: (render: (() => ReactNode) | undefined) => {
    useEffect(() => mocks.fixture().publish(render), [render]);
  },
}));

import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import { ThreadRouteScreen } from "./ThreadRouteScreen";

function setup() {
  let focused = true;
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  const paneListeners = new Set<() => void>();
  let inspector: (() => ReactNode) | undefined;
  const fixture = {
    selection: {
      selectedThread: {
        environmentId: EnvironmentId.make("environment"),
        id: ThreadId.make("thread-a"),
        title: "Thread",
        projectId: "project",
      },
      selectedThreadProject: { workspaceRoot: "/workspace", scripts: [] },
      selectedThreadCreation: null,
      selectedThreadDetailRef: null,
      selectedEnvironmentConnection: null,
    },
    navigation: {
      isFocused: () => focused,
      addListener: (event: "focus" | "blur", listener: () => void) => {
        listeners[event].add(listener);
        return () => listeners[event].delete(listener);
      },
      navigate: vi.fn(),
      setParams: vi.fn(),
    },
    layout: {
      fileInspector: { supported: true },
      layout: { usesSplitView: true },
      panes: { auxiliaryPaneVisible: true },
      showAuxiliaryPane: vi.fn(),
      toggleAuxiliaryPane: vi.fn(),
    },
    focus: (value: boolean) => {
      focused = value;
      for (const listener of listeners[value ? "focus" : "blur"]) listener();
    },
    publish: (render: (() => ReactNode) | undefined) => {
      inspector = render;
      for (const listener of paneListeners) listener();
    },
    subscribe: (listener: () => void) => {
      paneListeners.add(listener);
      return () => paneListeners.delete(listener);
    },
    getPane: () => inspector,
  };
  mocks.fixture.mockReturnValue(fixture);
  return fixture;
}

function Workspace({
  fixture,
  renderInspector,
}: {
  fixture: ReturnType<typeof setup>;
  renderInspector?: () => ReactNode;
}) {
  return (
    <NavigationContext value={fixture.navigation as unknown as NavigationProp<ParamListBase>}>
      <ThreadRouteScreen
        renderInspector={renderInspector}
        route={{
          params: {
            environmentId: "environment",
            threadId: fixture.selection.selectedThread.id,
          },
        }}
      />
      <PaneOutlet fixture={fixture} />
    </NavigationContext>
  );
}

function PaneOutlet({ fixture }: { fixture: ReturnType<typeof setup> }) {
  const renderPane = useSyncExternalStore(fixture.subscribe, fixture.getPane);
  return renderPane?.();
}

function press(renderer: ReactTestRenderer, label: string) {
  renderer.root
    .findAllByType("button")
    .find((button) => button.children.includes(label))!
    .props.onClick();
}

it("keeps Files open across a chat rerender and clears it on blur", async () => {
  const fixture = setup();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Workspace fixture={fixture} />);
  });
  try {
    await act(async () => press(renderer, "Files"));
    expect(
      renderer.root.findAllByType("span").some((span) => span.children.includes("Workspace files")),
    ).toBe(true);
    await act(async () => renderer.update(<Workspace fixture={fixture} />));
    expect(
      renderer.root.findAllByType("span").some((span) => span.children.includes("Workspace files")),
    ).toBe(true);
    await act(async () => fixture.focus(false));
    expect(renderer.root.findAllByType("span")).toHaveLength(0);
  } finally {
    await act(async () => renderer.unmount());
  }
});

it.each([
  ["Open new terminal", "term-1"],
  ["Open terminal", "terminal-existing"],
])("%s uses the terminal route and follows the current thread", async (label, terminalId) => {
  const fixture = setup();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Workspace fixture={fixture} />);
  });
  try {
    await act(async () => press(renderer, label));
    expect(fixture.navigation.navigate).toHaveBeenLastCalledWith("ThreadTerminal", {
      environmentId: "environment",
      threadId: "thread-a",
      terminalId,
    });
    fixture.selection.selectedThread = {
      ...fixture.selection.selectedThread,
      id: ThreadId.make("thread-b"),
    };
    await act(async () => renderer.update(<Workspace fixture={fixture} />));
    await act(async () => press(renderer, label));
    expect(fixture.navigation.navigate).toHaveBeenLastCalledWith("ThreadTerminal", {
      environmentId: "environment",
      threadId: "thread-b",
      terminalId,
    });
  } finally {
    await act(async () => renderer.unmount());
  }
});

it("keeps a route inspector mounted across chat rerenders", async () => {
  const fixture = setup();
  function Terminal() {
    const [input, setInput] = useState("");
    return <input value={input} onChange={(event) => setInput(event.target.value)} />;
  }
  const renderInspector = () => <Terminal />;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Workspace fixture={fixture} renderInspector={renderInspector} />);
  });
  try {
    await act(async () =>
      renderer.root.findByType("input").props.onChange({ target: { value: "echo retained" } }),
    );
    await act(async () =>
      renderer.update(<Workspace fixture={fixture} renderInspector={renderInspector} />),
    );
    expect(renderer.root.findByType("input").props.value).toBe("echo retained");
    await act(async () => renderer.update(<Workspace fixture={fixture} />));
    expect(renderer.root.findAllByType("input")).toHaveLength(0);
    await act(async () => press(renderer, "Files"));
    expect(
      renderer.root.findAllByType("span").some((span) => span.children.includes("Workspace files")),
    ).toBe(true);
  } finally {
    await act(async () => renderer.unmount());
  }
});
