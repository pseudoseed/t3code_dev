import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  StackActions,
  useFocusEffect,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Option from "effect/Option";
import {
  DEFAULT_TERMINAL_ID,
  EnvironmentId,
  ThreadId,
  type ProjectScript,
} from "@t3tools/contracts";
import {
  requestOlderThreadTurns,
  threadHasOlderTurns,
} from "@t3tools/client-runtime/state/threads";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useWorkspaceState } from "../../state/workspace";
import { useEnvironmentQuery } from "../../state/query";
import { dismissGitActionResult, useGitActionProgress } from "../../state/use-vcs-action-state";
import { vcsEnvironment } from "../../state/vcs";

import { EmptyState } from "../../components/EmptyState";
import {
  AndroidScreenHeader,
  type AndroidHeaderAction,
} from "../../components/AndroidScreenHeader";
import { LoadingScreen } from "../../components/LoadingScreen";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { connectionTone } from "../connection/connectionTone";

import {
  useRemoteConnections,
  useRemoteConnectionStatus,
  useRemoteEnvironmentRuntime,
} from "../../state/use-remote-environment-registry";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { useSelectedThreadDetailState } from "../../state/use-thread-detail";
import { useThreadSelection } from "../../state/use-thread-selection";
import { GitActionProgressOverlay } from "./GitActionProgressOverlay";
import {
  buildTerminalMenuSessions,
  nextOpenTerminalId,
  resolveProjectScriptTerminalId,
} from "../terminal/terminalMenu";
import {
  resolvePreferredThreadWorktreePath,
  stagePendingTerminalLaunch,
} from "../terminal/terminalLaunchContext";
import { terminalDebugLog } from "../terminal/terminalDebugLog";
import { ThreadTerminalPane } from "../terminal/ThreadTerminalPane";
import { useTerminalPaneDockPosition } from "../terminal/useTerminalPaneDockPosition";
import { pickRunningTerminalSessionForBootstrap } from "../terminal/useThreadTerminalSession";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { ThreadDetailScreen } from "./ThreadDetailScreen";
import {
  ThreadGitControls,
  useThreadGitCenterHeaderItems,
  useThreadGitRightHeaderItems,
} from "./ThreadGitControls";
import { GitOverviewSheet } from "./git/GitOverviewSheet";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useSelectedThreadRequests } from "../../state/use-selected-thread-requests";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { threadEnvironment } from "../../state/threads";
import { projectThreadContentPresentation } from "./threadContentPresentation";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceDock,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { ThreadFileNavigatorPane } from "../files/thread-file-navigator-pane";
import {
  ThreadInspectorContentStack,
  type ThreadInspectorMode,
} from "./thread-inspector-content-stack";

interface ThreadInspectorSelection {
  readonly routeThreadIdentity: string | null;
  readonly mode: ThreadInspectorMode;
}

type NativeHeaderItems = ReadonlyArray<Record<string, unknown>>;

function InspectorPaneRoleActivation() {
  useAdaptiveWorkspacePaneRole("inspector");
  return null;
}

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function OpeningThreadLoadingScreen() {
  return <LoadingScreen message="Opening thread…" messagePlacement="above-spinner" />;
}

type ThreadRouteScreenRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

interface ThreadRouteScreenProps extends ThreadRouteScreenRouteProps {
  readonly onReturnToThread?: () => void;
  readonly renderInspector?: (headerInset: number) => ReactNode;
}

function ThreadUnavailableScreen() {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: "center",
        paddingHorizontal: 24,
        paddingVertical: 32,
      }}
      className="bg-screen flex-1"
    >
      <EmptyState
        title="Thread unavailable"
        detail="This thread is not available in the current mobile snapshot."
      />
    </ScrollView>
  );
}

export function ThreadRouteScreen(props: ThreadRouteScreenProps) {
  const { state: workspaceState } = useWorkspaceState();
  const { connectionState } = useRemoteConnectionStatus();
  const { selectedThread } = useThreadSelection();
  const params = props.route.params;
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const threadIdRaw = firstRouteParam(params.threadId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeThreadKey =
    environmentId !== null && threadIdRaw !== null
      ? scopedThreadKey(environmentId, ThreadId.make(threadIdRaw))
      : null;
  const selectedThreadKey =
    selectedThread === null
      ? null
      : scopedThreadKey(selectedThread.environmentId, selectedThread.id);
  const selectedThreadDetailState = useSelectedThreadDetailState();

  if (environmentId === null || threadIdRaw === null) {
    return <OpeningThreadLoadingScreen />;
  }

  // Render the full thread chrome (header, feed, composer) as soon as the
  // thread SHELL is known — no blocking on message detail. The feed shows a
  // loading placeholder while messages fetch, the floating pill above the
  // composer reports loading/syncing, and the composer's connection pill
  // reports connecting/reconnecting status.
  if (selectedThread !== null && selectedThreadKey === routeThreadKey) {
    return <ThreadRouteContent {...props} selectedThreadDetailState={selectedThreadDetailState} />;
  }

  const stillHydrating =
    workspaceState.isLoadingConnections ||
    routeConnectionState === "connecting" ||
    routeConnectionState === "reconnecting";

  if (stillHydrating) {
    return <OpeningThreadLoadingScreen />;
  }

  return <ThreadUnavailableScreen />;
}

function ThreadRouteContent(
  props: ThreadRouteScreenProps & {
    readonly selectedThreadDetailState: ReturnType<typeof useSelectedThreadDetailState>;
  },
) {
  const {
    dock,
    fileInspector,
    layout,
    panes,
    showAuxiliaryPane,
    toggleAuxiliaryPane,
    togglePrimarySidebar,
  } = useAdaptiveWorkspaceLayout();
  const { connectionState } = useRemoteConnectionStatus();
  const { onReconnectEnvironment } = useRemoteConnections();
  const { selectedThread, selectedThreadProject, selectedEnvironmentConnection } =
    useThreadSelection();
  const selectedThreadDetailState = props.selectedThreadDetailState;
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  // "Load earlier turns" header state for windowed (paginated) thread loads.
  const loadEarlierTurns = useMemo(() => {
    if (selectedThread === null || !threadHasOlderTurns(selectedThreadDetailState)) {
      return null;
    }
    return {
      loading:
        selectedThreadDetailState.page._tag === "Some" &&
        selectedThreadDetailState.page.value.loadingOlder,
      onLoadEarlier: () => {
        requestOlderThreadTurns(selectedThread.environmentId, selectedThread.id);
      },
    };
  }, [selectedThread, selectedThreadDetailState]);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const composer = useThreadComposerState();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const requests = useSelectedThreadRequests();
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, "thread interrupt");
  const navigation = useNavigation();
  const params = props.route.params;
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const threadId = firstRouteParam(params.threadId);
  const routeThreadIdentity =
    environmentIdRaw !== null && threadId !== null ? `${environmentIdRaw}:${threadId}` : null;
  const [inspectorSelection, setInspectorSelection] = useState<ThreadInspectorSelection | null>(
    () => (props.renderInspector ? { routeThreadIdentity, mode: "route" } : null),
  );
  // Which shell the terminal pane is attached to, scoped to this thread so a
  // sidebar switch never lands on another thread's session.
  const [terminalPaneSelection, setTerminalPaneSelection] = useState<{
    readonly routeThreadIdentity: string | null;
    readonly terminalId: string;
    readonly open: boolean;
  }>(() => ({ routeThreadIdentity, terminalId: DEFAULT_TERMINAL_ID, open: false }));
  const inspectorMode = (() => {
    if (inspectorSelection?.routeThreadIdentity === routeThreadIdentity) {
      if (inspectorSelection.mode === "files" && selectedThreadCwd === null) {
        return null;
      }
      if (inspectorSelection.mode === "terminal" && !selectedThreadProject?.workspaceRoot) {
        return null;
      }
      return inspectorSelection.mode;
    }
    return null;
  })();
  useEffect(() => {
    if (
      fileInspector.supported &&
      selectedThreadCwd === null &&
      inspectorMode === null &&
      panes.auxiliaryPaneVisible
    ) {
      toggleAuxiliaryPane();
    }
  }, [
    fileInspector.supported,
    inspectorMode,
    panes.auxiliaryPaneVisible,
    selectedThreadCwd,
    toggleAuxiliaryPane,
  ]);

  useEffect(() => {
    setInspectorSelection((current) => {
      if (props.renderInspector === undefined) {
        if (current === null || current.mode === "route") {
          return null;
        }
        return { ...current, routeThreadIdentity };
      }

      if (current === null || current.mode === "route") {
        return { routeThreadIdentity, mode: "route" };
      }

      return { ...current, routeThreadIdentity };
    });
  }, [props.renderInspector, routeThreadIdentity]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        if (props.renderInspector === undefined) {
          // Inspectors are contextual to this chat destination. Clear the
          // hidden chat copy after a native push so returning from Files,
          // Review, or Terminal cannot reserve an empty trailing pane.
          setInspectorSelection(null);
        }
      };
    }, [props.renderInspector]),
  );
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeConnectionError = routeEnvironmentRuntime?.connectionError ?? null;
  const selectedThreadWithDraftSettings = useMemo(
    () =>
      selectedThread
        ? {
            ...selectedThread,
            modelSelection: composer.modelSelection ?? selectedThread.modelSelection,
            runtimeMode: composer.runtimeMode ?? selectedThread.runtimeMode,
            interactionMode: composer.interactionMode ?? selectedThread.interactionMode,
          }
        : null,
    [composer.interactionMode, composer.modelSelection, composer.runtimeMode, selectedThread],
  );

  /* ─── Native header theming ──────────────────────────────────────── */
  const usesNativeHeaderGlass = NATIVE_LIQUID_GLASS_SUPPORTED;
  const headerSubtitle = [
    selectedThreadProject?.title ?? null,
    selectedEnvironmentConnection?.environmentLabel ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  /* ─── Git status for native header trigger ───────────────────────── */
  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
  const terminalMenuSessions = useMemo(
    () =>
      buildTerminalMenuSessions({
        knownSessions: knownTerminalSessions,
        workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
      }),
    [knownTerminalSessions, selectedThreadProject?.workspaceRoot],
  );
  const selectedThreadDetailWorktreePath = selectedThreadDetail?.worktreePath ?? null;
  const handleReconnectEnvironment = useCallback(() => {
    if (!environmentId) {
      return;
    }
    onReconnectEnvironment(environmentId);
  }, [environmentId, onReconnectEnvironment]);

  /* ─── Git action progress (for overlay banner) ──────────────────── */
  const gitActionProgressTarget = useMemo(
    () => ({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadCwd,
    }),
    [selectedThread?.environmentId, selectedThreadCwd],
  );
  const gitActionProgress = useGitActionProgress(gitActionProgressTarget);

  const handleOpenGitInspector = useCallback(() => {
    if (!fileInspector.supported) {
      if (selectedThread === null) {
        return;
      }
      navigation.navigate("GitOverview", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
      });
      return;
    }
    setInspectorSelection({ routeThreadIdentity, mode: "git" });
    showAuxiliaryPane("inspector");
  }, [fileInspector.supported, navigation, routeThreadIdentity, selectedThread, showAuxiliaryPane]);
  const handleOpenFilesInspector = useCallback(() => {
    if (selectedThread === null || selectedThreadCwd === null) {
      return;
    }
    if (!fileInspector.supported) {
      navigation.navigate("ThreadFiles", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
      });
      return;
    }
    setInspectorSelection({
      routeThreadIdentity,
      mode: props.renderInspector === undefined ? "files" : "route",
    });
    showAuxiliaryPane("inspector");
  }, [
    fileInspector.supported,
    navigation,
    props.renderInspector,
    routeThreadIdentity,
    selectedThread,
    selectedThreadCwd,
    showAuxiliaryPane,
  ]);
  const inspectorToggleActionRef = useRef({
    inspectorMode,
    openFilesInspector: handleOpenFilesInspector,
    toggleAuxiliaryPane,
  });
  inspectorToggleActionRef.current = {
    inspectorMode,
    openFilesInspector: handleOpenFilesInspector,
    toggleAuxiliaryPane,
  };
  const handleToggleInspector = useCallback(() => {
    const action = inspectorToggleActionRef.current;
    if (action.inspectorMode === null) {
      action.openFilesInspector();
      return;
    }
    action.toggleAuxiliaryPane();
  }, []);
  const handleSelectInspectorFile = useCallback(
    (path: string) => {
      if (selectedThread === null) {
        return;
      }
      const params = {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        path: path.split("/").filter((segment) => segment.length > 0),
      };
      if (fileInspector.supported) {
        navigation.navigate("ThreadFile", params);
        return;
      }
      navigation.navigate("ThreadFile", params);
    },
    [fileInspector.supported, navigation, selectedThread],
  );
  // The workspace inspector column spans the full window height. On iOS the
  // git and files panes bring their own nested native headers (which underlap
  // the status bar); elsewhere the pane content pads itself below the top
  // inset. The terminal pane draws a plain tab strip instead of a native
  // header, so it always pads itself out of the status bar.
  const safeAreaInsets = useSafeAreaInsets();
  const inspectorHeaderInset = Platform.OS === "ios" ? 0 : safeAreaInsets.top;
  const terminalPaneHeaderInset = safeAreaInsets.top;
  // Regular widths host terminals in the workspace pane beside the chat;
  // compact widths keep pushing the full-screen terminal route.
  const supportsTerminalPane =
    fileInspector.supported && Boolean(selectedThreadProject?.workspaceRoot);
  const terminalPaneTerminalId =
    terminalPaneSelection.routeThreadIdentity === routeThreadIdentity
      ? terminalPaneSelection.terminalId
      : DEFAULT_TERMINAL_ID;
  const { dockPosition, toggleDockPosition } = useTerminalPaneDockPosition();
  // A short window has no room to split vertically; keep those on the side.
  const terminalDockPosition = dockPosition === "bottom" && dock.supported ? "bottom" : "right";
  const terminalPaneOpen =
    supportsTerminalPane &&
    terminalPaneSelection.routeThreadIdentity === routeThreadIdentity &&
    terminalPaneSelection.open;
  const showTerminalInInspector = terminalPaneOpen && terminalDockPosition === "right";
  const openTerminalPane = useCallback(
    (nextTerminalId: string) => {
      setTerminalPaneSelection({ routeThreadIdentity, terminalId: nextTerminalId, open: true });
      if (terminalDockPosition === "bottom") {
        return;
      }
      setInspectorSelection({ routeThreadIdentity, mode: "terminal" });
      showAuxiliaryPane("inspector");
    },
    [routeThreadIdentity, showAuxiliaryPane, terminalDockPosition],
  );
  const handleToggleTerminalDockPosition = useCallback(() => {
    if (!dock.supported && dockPosition === "right") {
      return;
    }
    const next = toggleDockPosition();
    if (next === "bottom") {
      // The dock renders the pane from here on; drop the trailing copy.
      setInspectorSelection((current) => (current?.mode === "terminal" ? null : current));
      return;
    }
    setInspectorSelection({ routeThreadIdentity, mode: "terminal" });
    showAuxiliaryPane("inspector");
  }, [dock.supported, dockPosition, routeThreadIdentity, showAuxiliaryPane, toggleDockPosition]);

  const GitInspector = useCallback(
    () => (
      <GitOverviewSheet
        headerInset={inspectorHeaderInset}
        presentation="inspector"
        route={{ params: props.route.params }}
      />
    ),
    [inspectorHeaderInset, props.route.params],
  );
  const FilesInspector = useCallback(
    () =>
      selectedThread !== null && selectedThreadCwd !== null ? (
        <ThreadFileNavigatorPane
          cwd={selectedThreadCwd}
          environmentId={selectedThread.environmentId}
          headerInset={inspectorHeaderInset}
          projectName={selectedThreadProject?.title ?? "Files"}
          selectedPath={null}
          onSelectFile={handleSelectInspectorFile}
        />
      ) : null,
    [
      handleSelectInspectorFile,
      inspectorHeaderInset,
      selectedThread,
      selectedThreadCwd,
      selectedThreadProject?.title,
    ],
  );
  const handleCloseTerminalPane = useCallback(() => {
    setTerminalPaneSelection((current) => ({ ...current, open: false }));
    setInspectorSelection((current) => (current?.mode === "terminal" ? null : current));
  }, []);
  // Maximizing MOVES the terminal to its own screen rather than leaving a
  // duplicate pane behind the push.
  const handleMaximizeTerminal = useCallback(() => {
    if (selectedThread === null) {
      return;
    }
    setTerminalPaneSelection((current) => ({ ...current, open: false }));
    setInspectorSelection((current) => (current?.mode === "terminal" ? null : current));
    void navigation.navigate("ThreadTerminal", {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      terminalId: terminalPaneTerminalId,
    });
  }, [navigation, selectedThread, terminalPaneTerminalId]);
  const handleSelectPaneTerminal = useCallback(
    (nextTerminalId: string) => {
      setTerminalPaneSelection({ routeThreadIdentity, terminalId: nextTerminalId, open: true });
    },
    [routeThreadIdentity],
  );
  const TerminalInspector = useCallback(
    () =>
      selectedThread !== null && selectedThreadProject?.workspaceRoot ? (
        <ThreadTerminalPane
          activeTerminalId={terminalPaneTerminalId}
          canDockBottom={dock.supported}
          dockPosition={terminalDockPosition}
          environmentId={selectedThread.environmentId}
          headerInset={terminalDockPosition === "bottom" ? 0 : terminalPaneHeaderInset}
          onClose={handleCloseTerminalPane}
          onMaximize={handleMaximizeTerminal}
          onSelectTerminal={handleSelectPaneTerminal}
          onToggleDockPosition={handleToggleTerminalDockPosition}
          threadDetailWorktreePath={selectedThreadDetailWorktreePath}
          threadId={selectedThread.id}
          threadWorktreePath={selectedThread.worktreePath ?? null}
          workspaceRoot={selectedThreadProject.workspaceRoot}
        />
      ) : null,
    [
      handleCloseTerminalPane,
      handleMaximizeTerminal,
      handleSelectPaneTerminal,
      handleToggleTerminalDockPosition,
      terminalPaneHeaderInset,
      selectedThread,
      selectedThreadDetailWorktreePath,
      selectedThreadProject?.workspaceRoot,
      dock.supported,
      terminalDockPosition,
      terminalPaneTerminalId,
    ],
  );
  const RouteInspector = useCallback(
    () => props.renderInspector?.(inspectorHeaderInset),
    [inspectorHeaderInset, props.renderInspector],
  );
  const renderInspectorStack = useCallback(
    () =>
      inspectorMode === null ? null : (
        <ThreadInspectorContentStack
          Files={FilesInspector}
          Git={GitInspector}
          mode={inspectorMode}
          Route={props.renderInspector ? RouteInspector : undefined}
          Terminal={showTerminalInInspector ? TerminalInspector : undefined}
        />
      ),
    [
      FilesInspector,
      GitInspector,
      RouteInspector,
      TerminalInspector,
      inspectorMode,
      props.renderInspector,
      showTerminalInInspector,
    ],
  );
  const activeInspectorRenderer = inspectorMode === null ? undefined : renderInspectorStack;
  // Hand the inspector to the workspace so it renders beside the navigator,
  // outside this screen's native header — the terminal/git/files toolbar
  // stays anchored to the chat pane instead of floating above the inspector.
  useRegisterWorkspaceInspector(activeInspectorRenderer);
  // A bottom-docked terminal renders under the chat instead of beside it, so
  // it takes the dock channel and leaves the trailing column to files/git.
  useRegisterWorkspaceDock(
    terminalPaneOpen && terminalDockPosition === "bottom" ? TerminalInspector : undefined,
  );

  const handleOpenConnectionEditor = useCallback(() => {
    void navigation.navigate("Connections");
  }, [navigation]);
  const handleStopThread = useCallback(() => {
    if (
      !selectedThread ||
      (selectedThread.session?.status !== "running" &&
        selectedThread.session?.status !== "starting")
    ) {
      return;
    }
    return interruptThreadTurn({
      environmentId: selectedThread.environmentId,
      input: {
        threadId: selectedThread.id,
        ...(selectedThread.session.activeTurnId
          ? { turnId: selectedThread.session.activeTurnId }
          : {}),
      },
    });
  }, [interruptThreadTurn, selectedThread]);

  const handleOpenTerminal = useCallback(
    (nextTerminalId?: string | null) => {
      terminalDebugLog("terminal-menu:open-existing", {
        terminalId: nextTerminalId ?? null,
        hasThread: Boolean(selectedThread),
        hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      });

      if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
        return;
      }

      if (supportsTerminalPane) {
        openTerminalPane(
          nextTerminalId ??
            pickRunningTerminalSessionForBootstrap(knownTerminalSessions)?.target.terminalId ??
            DEFAULT_TERMINAL_ID,
        );
        return;
      }

      void navigation.navigate("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        ...(nextTerminalId ? { terminalId: nextTerminalId } : {}),
      });
    },
    [
      knownTerminalSessions,
      navigation,
      openTerminalPane,
      selectedThread,
      selectedThreadProject?.workspaceRoot,
      supportsTerminalPane,
    ],
  );

  const handleOpenNewTerminal = useCallback(() => {
    terminalDebugLog("terminal-menu:open-new", {
      hasThread: Boolean(selectedThread),
      hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
    });

    if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
      return;
    }

    const nextId = nextOpenTerminalId({
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
      ...(inspectorMode === "terminal" ? { activeRouteTerminalId: terminalPaneTerminalId } : {}),
    });
    if (supportsTerminalPane) {
      openTerminalPane(nextId);
      return;
    }
    void navigation.navigate("ThreadTerminal", {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      terminalId: nextId,
    });
  }, [
    inspectorMode,
    navigation,
    openTerminalPane,
    selectedThread,
    selectedThreadProject?.workspaceRoot,
    supportsTerminalPane,
    terminalMenuSessions,
    terminalPaneTerminalId,
  ]);

  // Cmd-shortcut parity with the chat toolbar: open the pane where one fits,
  // otherwise fall through to the provider's full-screen terminal route.
  const handleTerminalKeyboardCommand = useCallback(() => {
    if (!supportsTerminalPane) {
      return false;
    }
    handleOpenTerminal(null);
    return true;
  }, [handleOpenTerminal, supportsTerminalPane]);
  useHardwareKeyboardCommand("terminal", handleTerminalKeyboardCommand);

  const handleRunProjectScript = useCallback(
    async (script: ProjectScript) => {
      terminalDebugLog("project-script:press", {
        scriptId: script.id,
        command: script.command,
        hasThread: Boolean(selectedThread),
        hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      });

      if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
        terminalDebugLog("project-script:abort", {
          scriptId: script.id,
          reason: "no-thread-or-workspace",
        });
        return;
      }

      const targetTerminalId = resolveProjectScriptTerminalId({
        existingTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
        hasRunningTerminal: terminalMenuSessions.some(
          (session) => session.status === "running" || session.status === "starting",
        ),
      });
      const preferredWorktreePath = resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: selectedThread.worktreePath ?? null,
        threadDetailWorktreePath: selectedThreadDetailWorktreePath,
      });
      const cwd = projectScriptCwd({
        project: { cwd: selectedThreadProject.workspaceRoot },
        worktreePath: preferredWorktreePath,
      });
      const env = projectScriptRuntimeEnv({
        project: { cwd: selectedThreadProject.workspaceRoot },
        worktreePath: preferredWorktreePath,
      });
      stagePendingTerminalLaunch({
        target: {
          environmentId: selectedThread.environmentId,
          threadId: selectedThread.id,
          terminalId: targetTerminalId,
        },
        launch: {
          cwd,
          worktreePath: preferredWorktreePath,
          env,
          initialInput: `${script.command}\r`,
        },
      });
      terminalDebugLog("project-script:staged", {
        scriptId: script.id,
        terminalId: targetTerminalId,
        cwd,
        worktreePath: preferredWorktreePath,
      });

      if (supportsTerminalPane) {
        openTerminalPane(targetTerminalId);
        return;
      }

      void navigation.navigate("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        terminalId: targetTerminalId,
      });
    },
    [
      navigation,
      openTerminalPane,
      selectedThread,
      selectedThreadDetailWorktreePath,
      selectedThreadProject,
      supportsTerminalPane,
      terminalMenuSessions,
    ],
  );
  const threadGitControlProps = {
    environmentId: environmentIdRaw ?? "",
    threadId: threadId ?? "",
    auxiliaryPaneControl:
      !layout.usesSplitView && fileInspector.supported && selectedThreadCwd !== null
        ? {
            accessibilityLabel: "Toggle inspector",
            onPress: handleToggleInspector,
          }
        : undefined,
    onOpenFilesInspector:
      fileInspector.supported && selectedThreadCwd !== null ? handleOpenFilesInspector : undefined,
    onOpenGitInspector: fileInspector.supported ? handleOpenGitInspector : undefined,
    currentBranch: selectedThread?.branch ?? null,
    gitStatus: gitStatus.data,
    gitOperationLabel: gitState.gitOperationLabel,
    canOpenTerminal: Boolean(selectedThreadProject?.workspaceRoot),
    canOpenFiles: Boolean(selectedThreadProject?.workspaceRoot),
    projectScripts: selectedThreadProject?.scripts ?? [],
    terminalSessions: terminalMenuSessions,
    showDirectFileControl: layout.usesSplitView,
    onOpenTerminal: handleOpenTerminal,
    onOpenNewTerminal: handleOpenNewTerminal,
    onRunProjectScript: handleRunProjectScript,
    onPull: gitActions.onPullSelectedThreadBranch,
    onRunAction: gitActions.onRunSelectedThreadGitAction,
  };
  const threadCenterHeaderItems = useThreadGitCenterHeaderItems(threadGitControlProps);
  const compactRightHeaderItems = useThreadGitRightHeaderItems(threadGitControlProps);
  const splitLeftHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      {
        // Match Mail's split-view detail toolbar: the first detail action sits
        // inside the content pane, not flush against the sidebar divider.
        spacing: 18,
        type: "spacing" as const,
      },
      ...(props.onReturnToThread
        ? [
            withNativeGlassHeaderItem({
              accessibilityLabel: "Return to chat",
              icon: { name: "chevron.left", type: "sfSymbol" as const },
              identifier: "thread-left-return",
              onPress: props.onReturnToThread,
              type: "button" as const,
            }),
          ]
        : []),
      withNativeGlassHeaderItem({
        accessibilityLabel: panes.primarySidebarVisible
          ? "Maximize content"
          : "Show thread sidebar",
        icon: {
          name: panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left",
          type: "sfSymbol" as const,
        },
        identifier: "thread-left-sidebar",
        onPress: togglePrimarySidebar,
        type: "button" as const,
      }),
      withNativeGlassHeaderItem({
        accessibilityLabel: "New task",
        icon: { name: "square.and.pencil", type: "sfSymbol" as const },
        identifier: "thread-left-new-task",
        onPress: () => navigation.navigate("NewTaskSheet", { screen: "NewTask" }),
        type: "button" as const,
      }),
    ],
    [panes.primarySidebarVisible, props.onReturnToThread, navigation, togglePrimarySidebar],
  );
  const androidHeaderActions = useMemo<ReadonlyArray<AndroidHeaderAction>>(() => {
    if (Platform.OS !== "android") return [];

    const actions: AndroidHeaderAction[] = [];
    if (props.onReturnToThread) {
      actions.push({
        accessibilityLabel: "Return to chat",
        icon: "chevron.left",
        onPress: props.onReturnToThread,
      });
    }
    if (selectedThreadCwd !== null) {
      actions.push({
        accessibilityLabel: "Open files",
        icon: "folder",
        onPress: handleOpenFilesInspector,
      });
    }
    if (selectedThreadProject?.workspaceRoot) {
      actions.push({
        accessibilityLabel: "Open terminal",
        icon: "terminal",
        onPress: () => handleOpenTerminal(null),
      });
    }
    actions.push({
      accessibilityLabel: "Open git controls",
      icon: "point.topleft.down.curvedto.point.bottomright.up",
      onPress: handleOpenGitInspector,
    });
    if (fileInspector.supported && selectedThreadCwd !== null) {
      actions.push({
        accessibilityLabel: "Toggle inspector",
        icon: "sidebar.right",
        onPress: handleToggleInspector,
      });
    }
    return actions;
  }, [
    fileInspector.supported,
    handleOpenFilesInspector,
    handleOpenTerminal,
    handleOpenGitInspector,
    handleToggleInspector,
    props.onReturnToThread,
    selectedThreadCwd,
    selectedThreadProject?.workspaceRoot,
  ]);

  // Deep links / cold starts land with Thread as the ONLY route, where the
  // native back button does not render. Provide an explicit Home escape for
  // that case; when history exists the native back button is used instead.
  const canGoBack = navigation.canGoBack();
  const compactHomeHeaderItems = useMemo<NativeHeaderItems>(
    () => [
      withNativeGlassHeaderItem({
        accessibilityLabel: "Go to threads list",
        icon: { name: "list.bullet", type: "sfSymbol" as const },
        identifier: "thread-left-home",
        onPress: () => navigation.dispatch(StackActions.replace("Home")),
        type: "button" as const,
      }),
    ],
    [navigation],
  );

  if (!environmentId || !threadId) {
    return <OpeningThreadLoadingScreen />;
  }

  if (!selectedThread) {
    return <OpeningThreadLoadingScreen />;
  }

  const contentPresentation = projectThreadContentPresentation({
    hasDetail: selectedThreadDetail !== null,
    detailError: Option.getOrNull(selectedThreadDetailState.error),
    detailDeleted: selectedThreadDetailState.status === "deleted",
    connectionState: routeConnectionState,
  });
  const serverConfig = routeEnvironmentRuntime?.serverConfig ?? null;
  const renderThreadRouteBody = (showActionControls: boolean) => (
    <>
      <ThreadGitControls {...threadGitControlProps} showActionControls={showActionControls} />

      <GitActionProgressOverlay progress={gitActionProgress} onDismiss={dismissGitActionResult} />

      <View className="flex-1 bg-screen">
        <ThreadDetailScreen
          selectedThread={selectedThreadWithDraftSettings ?? selectedThread}
          contentPresentation={contentPresentation}
          screenTone={connectionTone(routeConnectionState)}
          connectionError={routeConnectionError}
          environmentLabel={selectedEnvironmentConnection?.environmentLabel ?? null}
          selectedThreadFeed={composer.selectedThreadFeed}
          activeWorkStartedAt={composer.activeWorkStartedAt}
          isCompacting={composer.isCompacting}
          activePendingApproval={requests.activePendingApproval}
          respondingApprovalId={requests.respondingApprovalId}
          activePendingUserInput={requests.activePendingUserInput}
          activePendingUserInputDrafts={requests.activePendingUserInputDrafts}
          activePendingUserInputAnswers={requests.activePendingUserInputAnswers}
          respondingUserInputId={requests.respondingUserInputId}
          draftMessage={composer.draftMessage}
          draftAttachments={composer.draftAttachments}
          connectionStateLabel={routeConnectionState}
          threadSyncStatus={selectedThreadDetailState.status}
          loadEarlier={loadEarlierTurns}
          environmentId={selectedThread.environmentId}
          projectWorkspaceRoot={selectedThreadProject?.workspaceRoot ?? null}
          threadCwd={selectedThreadCwd}
          selectedThreadQueueCount={composer.selectedThreadQueueCount}
          layoutVariant={layout.variant}
          usesAutomaticContentInsets={usesNativeHeaderGlass}
          onOpenConnectionEditor={handleOpenConnectionEditor}
          onChangeDraftMessage={composer.onChangeDraftMessage}
          onPickDraftMedia={composer.onPickDraftMedia}
          onPickDraftFiles={composer.onPickDraftFiles}
          onNativePasteImages={composer.onNativePasteImages}
          onRemoveDraftImage={composer.onRemoveDraftImage}
          serverConfig={serverConfig}
          onStopThread={handleStopThread}
          onSendMessage={composer.onSendMessage}
          onReconnectEnvironment={handleReconnectEnvironment}
          onUpdateThreadModelSelection={composer.onUpdateModelSelection}
          threadSubagentModelSelection={composer.subagentModelSelection}
          onUpdateThreadSubagentModelSelection={composer.onUpdateSubagentModelSelection}
          onUpdateThreadRuntimeMode={composer.onUpdateRuntimeMode}
          onUpdateThreadInteractionMode={composer.onUpdateInteractionMode}
          onRespondToApproval={requests.onRespondToApproval}
          onSelectUserInputOption={requests.onSelectUserInputOption}
          onChangeUserInputCustomAnswer={requests.onChangeUserInputCustomAnswer}
          onSubmitUserInput={requests.onSubmitUserInput}
        />
      </View>
    </>
  );

  return (
    <>
      {activeInspectorRenderer ? <InspectorPaneRoleActivation /> : null}
      <NativeStackScreenOptions
        options={{
          // Android draws its own in-flow header (AndroidScreenHeader below);
          // the native stack header stays iOS-only.
          headerShown: Platform.OS !== "android",
          headerTitle: selectedThread.title,
          headerTitleStyle: usesNativeHeaderGlass
            ? {
                fontSize: 17,
                fontWeight: "800",
              }
            : undefined,
          title: selectedThread.title,
          headerBackVisible: !layout.usesSplitView,
          // Compact uses the NATIVE back button when a previous route exists;
          // deep links / cold starts get an explicit Home button instead.
          // Split view always uses its custom left items.
          unstable_headerLeftItems:
            Platform.OS === "ios"
              ? layout.usesSplitView
                ? () => splitLeftHeaderItems
                : canGoBack
                  ? undefined
                  : () => compactHomeHeaderItems
              : undefined,
          // Search lives in the persistent sidebar, so the split header keeps
          // the git controls on the RIGHT (no center items — center space is
          // reserved for future breadcrumbs/status).
          unstable_headerRightItems:
            Platform.OS === "ios"
              ? () => (layout.usesSplitView ? threadCenterHeaderItems : compactRightHeaderItems)
              : undefined,
          unstable_headerSubtitle: usesNativeHeaderGlass ? headerSubtitle : undefined,
        }}
      />

      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={selectedThread.title}
          subtitle={headerSubtitle}
          onBack={layout.usesSplitView ? undefined : () => navigation.goBack()}
          actions={androidHeaderActions}
        />
      ) : null}

      {/* Android surfaces the git/files/inspector actions in its in-flow
          header above, so the fallback action toolbar stays iOS-only. */}
      {renderThreadRouteBody(
        Platform.OS !== "android" && !layout.usesSplitView && !usesNativeHeaderGlass,
      )}
    </>
  );
}
