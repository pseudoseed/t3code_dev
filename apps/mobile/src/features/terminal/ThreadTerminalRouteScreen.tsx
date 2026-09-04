import { DEFAULT_TERMINAL_ID, EnvironmentId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Platform, View } from "react-native";

import { AndroidHeaderIconButton, AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ControlPillMenu } from "../../components/ControlPill";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceState } from "../../state/workspace";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STEP,
  stepTerminalFontSize,
} from "../../lib/appearancePreferences";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { TerminalSurfacePanel } from "./TerminalSurfacePanel";
import { getMobileTerminalTheme } from "./terminalTheme";
import { terminalDebugLog } from "./terminalDebugLog";
import {
  basename,
  buildTerminalMenuSessions,
  getTerminalStatusLabel,
  nextOpenTerminalId,
  previousLiveTerminalId,
  resolveTerminalSessionLabel,
  type TerminalMenuSession,
} from "./terminalMenu";
import {
  pickRunningTerminalSessionForBootstrap,
  useThreadTerminalSession,
} from "./useThreadTerminalSession";

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

type ThreadTerminalRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly terminalId?: string;
}>;

/**
 * The full-screen terminal: the compact-width surface, and where the
 * workspace terminal pane maximizes to. Session behaviour lives in
 * useThreadTerminalSession; this screen owns navigation and native chrome.
 */
export function ThreadTerminalRouteScreen(props: ThreadTerminalRouteScreenProps) {
  const navigation = useNavigation();
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const { state: workspaceState } = useWorkspaceState();
  const { layout, panes, togglePrimarySidebar } = useAdaptiveWorkspaceLayout();
  const params = props.route.params;
  const { selectedThread, selectedThreadProject, selectedEnvironmentConnection } =
    useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const routeEnvironmentIdRaw = firstRouteParam(params.environmentId);
  const routeEnvironmentId = routeEnvironmentIdRaw
    ? EnvironmentId.make(routeEnvironmentIdRaw)
    : null;
  const environment = useEnvironmentPresentation(routeEnvironmentId);
  const isEnvironmentReady = environment.presentation?.connection.phase === "connected";
  const requestedTerminalId = firstRouteParam(params.terminalId);
  const terminalId = requestedTerminalId ?? DEFAULT_TERMINAL_ID;
  const {
    isReady: hasResolvedFontPreference,
    appearance,
    themeAppearance: appearanceScheme,
    themeId,
    setTerminalFontSize,
  } = useAppearancePreferences();
  const fontSize = appearance.terminalFontSize;
  const knownSessions = useKnownTerminalSessions({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
  const runningSession = useMemo(
    () => pickRunningTerminalSessionForBootstrap(knownSessions),
    [knownSessions],
  );
  const shouldRedirectToRunningTerminal =
    requestedTerminalId === null &&
    runningSession !== null &&
    runningSession.target.terminalId !== terminalId;

  // The exit handler needs the session list this screen derives BELOW, so the
  // session hook calls through a ref that is refreshed every render.
  const sessionEndedRef = useRef<(input: { readonly terminalId: string }) => void>(() => undefined);
  const handleSessionEnded = useCallback((input: { readonly terminalId: string }) => {
    sessionEndedRef.current(input);
  }, []);

  const session = useThreadTerminalSession({
    enabled: !shouldRedirectToRunningTerminal,
    environmentId: selectedThread?.environmentId ?? null,
    fontSize,
    hasResolvedFontPreference,
    isEnvironmentReady,
    onSessionEnded: handleSessionEnded,
    terminalId,
    threadDetailWorktreePath: selectedThreadDetail?.worktreePath ?? null,
    threadId: selectedThread?.id ?? null,
    threadWorktreePath: selectedThread?.worktreePath ?? null,
    workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
  });
  const terminal = session.terminal;
  const terminalKey = session.terminalKey;

  const terminalMenuSessions = useMemo<ReadonlyArray<TerminalMenuSession>>(
    () =>
      buildTerminalMenuSessions({
        knownSessions,
        workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
        currentSession: {
          terminalId,
          cwd: session.cwd,
          status: terminal.status,
          hasRunningSubprocess: terminal.hasRunningSubprocess,
          displayLabel: resolveTerminalSessionLabel(terminalId, terminal.summary),
          updatedAt: terminal.updatedAt,
        },
      }),
    [
      knownSessions,
      selectedThreadProject?.workspaceRoot,
      session.cwd,
      terminal.hasRunningSubprocess,
      terminal.status,
      terminal.summary,
      terminal.updatedAt,
      terminalId,
    ],
  );

  useEffect(() => {
    if (!shouldRedirectToRunningTerminal || !selectedThread || !runningSession) {
      return;
    }
    navigation.dispatch(
      StackActions.replace("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        terminalId: runningSession.target.terminalId,
      }),
    );
  }, [navigation, runningSession, selectedThread, shouldRedirectToRunningTerminal]);

  const handleSelectTerminal = useCallback(
    (nextTerminalId: string) => {
      if (!selectedThread || nextTerminalId === terminalId) {
        return;
      }

      navigation.dispatch(
        StackActions.replace("ThreadTerminal", {
          environmentId: String(selectedThread.environmentId),
          threadId: String(selectedThread.id),
          terminalId: nextTerminalId,
        }),
      );
    },
    [navigation, selectedThread, terminalId],
  );

  const returnToThread = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    // Deep-linked/root mounts have nothing to pop; land on the thread instead
    // of stranding the user on a screen with no way out.
    if (selectedThread) {
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: String(selectedThread.environmentId),
          threadId: String(selectedThread.id),
        }),
      );
    }
  }, [navigation, selectedThread]);

  const navigateAwayAfterExit = useCallback(() => {
    // With other shells still live, fall through to the previous one instead
    // of dropping the user back on the thread.
    const fallbackTerminalId = previousLiveTerminalId({
      sessions: terminalMenuSessions,
      exitedTerminalId: terminalId,
    });
    if (fallbackTerminalId !== null && selectedThread) {
      navigation.dispatch(
        StackActions.replace("ThreadTerminal", {
          environmentId: String(selectedThread.environmentId),
          threadId: String(selectedThread.id),
          terminalId: fallbackTerminalId,
        }),
      );
      return;
    }
    returnToThread();
  }, [navigation, returnToThread, selectedThread, terminalId, terminalMenuSessions]);

  // An unfocused screen can't navigate; leave when the user returns so they
  // never land on a dead session.
  const pendingExitNavigationRef = useRef<string | null>(null);
  sessionEndedRef.current = () => {
    if (navigation.isFocused()) {
      navigateAwayAfterExit();
      return;
    }
    pendingExitNavigationRef.current = terminalKey;
  };

  useEffect(
    () =>
      navigation.addListener("focus", () => {
        if (pendingExitNavigationRef.current !== terminalKey) {
          return;
        }
        pendingExitNavigationRef.current = null;
        navigateAwayAfterExit();
      }),
    [navigateAwayAfterExit, navigation, terminalKey],
  );

  // The session came back (e.g. respawned elsewhere) before the user
  // returned; a stale pending exit must not eject a live terminal.
  useEffect(() => {
    if (session.isRunning) {
      pendingExitNavigationRef.current = null;
    }
  }, [session.isRunning]);

  const handleOpenNewTerminal = useCallback(() => {
    if (!selectedThread) {
      return;
    }

    navigation.dispatch(
      StackActions.replace("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        terminalId: nextOpenTerminalId({
          listedTerminalIds: terminalMenuSessions.map((menuSession) => menuSession.terminalId),
          activeRouteTerminalId: terminalId,
        }),
      }),
    );
  }, [navigation, selectedThread, terminalId, terminalMenuSessions]);

  const handleDecreaseFontSize = useCallback(() => {
    setTerminalFontSize(stepTerminalFontSize(fontSize, -1));
  }, [fontSize, setTerminalFontSize]);

  const handleIncreaseFontSize = useCallback(() => {
    setTerminalFontSize(stepTerminalFontSize(fontSize, 1));
  }, [fontSize, setTerminalFontSize]);

  // Android mirror of the iOS NativeHeaderToolbar terminal menu below: text
  // size, session switching, and "Open new terminal", rendered through the
  // token-styled anchored menu (the native header items are iOS-only).
  const androidTerminalMenuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "text-size",
        title: "Text size",
        subactions: [
          {
            id: "font-decrease",
            title: `A- ${Math.max(MIN_TERMINAL_FONT_SIZE, fontSize - TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`,
            attributes: fontSize <= MIN_TERMINAL_FONT_SIZE ? { disabled: true } : undefined,
          },
          {
            id: "font-increase",
            title: `A+ ${Math.min(MAX_TERMINAL_FONT_SIZE, fontSize + TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`,
            attributes: fontSize >= MAX_TERMINAL_FONT_SIZE ? { disabled: true } : undefined,
          },
        ],
      },
      ...terminalMenuSessions.map((menuSession): MenuAction => ({
        id: `terminal-session:${menuSession.terminalId}`,
        title: menuSession.displayLabel,
        subtitle: [
          getTerminalStatusLabel({ status: menuSession.status }),
          basename(menuSession.cwd),
        ]
          .filter(Boolean)
          .join(" · "),
        state: menuSession.terminalId === terminalId ? ("on" as const) : undefined,
      })),
      {
        id: "terminal-new",
        title: "Open new terminal",
        image: "plus",
        subtitle: `Start another shell in ${basename(selectedThreadProject?.workspaceRoot ?? null) ?? "this workspace"}`,
      },
    ],
    [fontSize, selectedThreadProject?.workspaceRoot, terminalId, terminalMenuSessions],
  );

  const handleAndroidTerminalMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const id = event.nativeEvent.event;
      if (id === "font-decrease") {
        handleDecreaseFontSize();
        return;
      }
      if (id === "font-increase") {
        handleIncreaseFontSize();
        return;
      }
      if (id === "terminal-new") {
        handleOpenNewTerminal();
        return;
      }
      if (id.startsWith("terminal-session:")) {
        handleSelectTerminal(id.slice("terminal-session:".length));
      }
    },
    [handleDecreaseFontSize, handleIncreaseFontSize, handleOpenNewTerminal, handleSelectTerminal],
  );

  const handleRetryEnvironment = useCallback(() => {
    if (routeEnvironmentId !== null) {
      void retryEnvironment(routeEnvironmentId);
    }
  }, [retryEnvironment, routeEnvironmentId]);

  useEffect(() => {
    terminalDebugLog("surface:props", {
      terminalKey,
      surfaceBufferLen: session.surfaceContent.buffer.length,
      status: terminal.status,
      version: terminal.version,
    });
  }, [session.surfaceContent.buffer.length, terminal.status, terminal.version, terminalKey]);

  const terminalTheme = getMobileTerminalTheme(themeId, appearanceScheme);
  const usesNativeHeaderGlass = Platform.OS === "ios";
  const headerSubtitle = selectedThreadProject?.title ?? "";

  if (!selectedThread) {
    if (workspaceState.isLoadingConnections) {
      return <LoadingScreen message="Opening terminal…" />;
    }

    return (
      <View className="flex-1 bg-screen">
        <EmptyState
          title="Thread unavailable"
          detail="This terminal route needs an active thread and workspace."
        />
      </View>
    );
  }

  if (!selectedThreadProject?.workspaceRoot) {
    return (
      <View className="flex-1 bg-screen">
        <EmptyState
          title="Terminal unavailable"
          detail="This thread does not have a workspace root yet, so there is nowhere to open a shell."
        />
      </View>
    );
  }

  if (!environment.isReady && environment.presentation === null) {
    return <LoadingScreen message="Opening terminal…" />;
  }

  return (
    <>
      <NativeStackScreenOptions
        options={{
          // Static header config lives in Stack.tsx (SOLID_HEADER_OPTIONS — the pty
          // scrolls internally, nothing for glass to sample). Default title/subtitle
          // styling, like every other page.
          // Android draws its own in-flow header (AndroidScreenHeader below);
          // the native stack header stays iOS-only.
          headerShown: Platform.OS !== "android",
          title: "Terminal",
          unstable_headerSubtitle:
            usesNativeHeaderGlass && headerSubtitle.length > 0 ? headerSubtitle : undefined,
        }}
      />

      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title="Terminal"
          subtitle={headerSubtitle}
          onBack={returnToThread}
          trailing={
            <>
              {layout.usesSplitView ? (
                <AndroidHeaderIconButton
                  accessibilityLabel={
                    panes.primarySidebarVisible ? "Maximize terminal" : "Show threads"
                  }
                  icon={
                    panes.primarySidebarVisible
                      ? "arrow.up.left.and.arrow.down.right"
                      : "sidebar.left"
                  }
                  onPress={togglePrimarySidebar}
                />
              ) : null}
              {isEnvironmentReady ? (
                <ControlPillMenu
                  actions={androidTerminalMenuActions}
                  isAnchoredToRight
                  title={getTerminalStatusLabel({
                    status: terminal.status,
                    hasRunningSubprocess: terminal.hasRunningSubprocess,
                  })}
                  onPressAction={handleAndroidTerminalMenuAction}
                >
                  <AndroidHeaderIconButton accessibilityLabel="Terminal options" icon="terminal" />
                </ControlPillMenu>
              ) : null}
            </>
          }
        />
      ) : null}

      {layout.usesSplitView ? (
        // Custom left items replace the native back button, so the way back to
        // chat has to be one of them.
        <NativeHeaderToolbar placement="left">
          <NativeHeaderToolbar.Button
            accessibilityLabel="Return to chat"
            icon="chevron.left"
            onPress={returnToThread}
            separateBackground
          />
          <NativeHeaderToolbar.Button
            accessibilityLabel={panes.primarySidebarVisible ? "Maximize terminal" : "Show threads"}
            icon={
              panes.primarySidebarVisible ? "arrow.up.left.and.arrow.down.right" : "sidebar.left"
            }
            onPress={togglePrimarySidebar}
            separateBackground
          />
        </NativeHeaderToolbar>
      ) : null}

      {isEnvironmentReady ? (
        <NativeHeaderToolbar placement="right">
          <NativeHeaderToolbar.Menu icon="terminal" title="Terminal options" separateBackground>
            <NativeHeaderToolbar.Label>
              {getTerminalStatusLabel({
                status: terminal.status,
                hasRunningSubprocess: terminal.hasRunningSubprocess,
              })}
            </NativeHeaderToolbar.Label>
            <NativeHeaderToolbar.Menu icon="textformat.size" inline title="Text size">
              <NativeHeaderToolbar.Label>Text size</NativeHeaderToolbar.Label>
              <NativeHeaderToolbar.MenuAction
                disabled={fontSize <= MIN_TERMINAL_FONT_SIZE}
                discoverabilityLabel="Decrease terminal text size"
                onPress={handleDecreaseFontSize}
              >
                <NativeHeaderToolbar.Label>{`A- ${Math.max(MIN_TERMINAL_FONT_SIZE, fontSize - TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`}</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              <NativeHeaderToolbar.MenuAction
                disabled={fontSize >= MAX_TERMINAL_FONT_SIZE}
                discoverabilityLabel="Increase terminal text size"
                onPress={handleIncreaseFontSize}
              >
                <NativeHeaderToolbar.Label>{`A+ ${Math.min(MAX_TERMINAL_FONT_SIZE, fontSize + TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`}</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            </NativeHeaderToolbar.Menu>
            {terminalMenuSessions.map((menuSession) => (
              <NativeHeaderToolbar.MenuAction
                key={menuSession.terminalId}
                icon={menuSession.terminalId === terminalId ? "checkmark" : "terminal"}
                onPress={() => handleSelectTerminal(menuSession.terminalId)}
                subtitle={[
                  getTerminalStatusLabel({ status: menuSession.status }),
                  basename(menuSession.cwd),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                <NativeHeaderToolbar.Label>{menuSession.displayLabel}</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            ))}
            <NativeHeaderToolbar.MenuAction
              icon="plus"
              onPress={handleOpenNewTerminal}
              subtitle={`Start another shell in ${basename(selectedThreadProject.workspaceRoot) ?? "this workspace"}`}
            >
              <NativeHeaderToolbar.Label>Open new terminal</NativeHeaderToolbar.Label>
            </NativeHeaderToolbar.MenuAction>
          </NativeHeaderToolbar.Menu>
        </NativeHeaderToolbar>
      ) : null}

      <View className="flex-1" style={{ backgroundColor: terminalTheme.background }}>
        {!isEnvironmentReady ? (
          <EnvironmentConnectionNotice
            environmentLabel={
              environment.presentation?.entry.target.label ??
              selectedEnvironmentConnection?.environmentLabel ??
              "Environment"
            }
            connection={
              environment.presentation?.connection ?? {
                phase: "available",
                error: null,
                traceId: null,
              }
            }
            resourceName="terminal"
            onRetry={handleRetryEnvironment}
          />
        ) : (
          <TerminalSurfacePanel
            content={session.surfaceContent}
            environmentLabel={selectedEnvironmentConnection?.environmentLabel ?? null}
            fontSize={fontSize}
            isRunning={session.isRunning}
            onClear={session.clearTerminal}
            onInput={session.sendInput}
            onResize={session.handleResize}
            onToggleModifier={session.togglePendingModifier}
            pendingModifier={session.pendingModifier}
            terminalKey={terminalKey}
            theme={terminalTheme}
          />
        )}
      </View>
    </>
  );
}
