import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo, useRef } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { environmentCatalog } from "../../connection/catalog";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentPresentation } from "../../state/presentation";
import { EnvironmentConnectionNotice } from "../connection/EnvironmentConnectionNotice";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { TerminalSurfacePanel } from "./TerminalSurfacePanel";
import {
  basename,
  buildTerminalMenuSessions,
  getTerminalStatusLabel,
  nextOpenTerminalId,
  previousLiveTerminalId,
  resolveTerminalSessionLabel,
  type TerminalMenuSession,
} from "./terminalMenu";
import { getMobileTerminalTheme } from "./terminalTheme";
import type { TerminalTheme } from "./terminalTheme";
import { useThreadTerminalSession } from "./useThreadTerminalSession";

const TAB_STRIP_HEIGHT = 44;

export type TerminalPaneDockPosition = "right" | "bottom";

function TerminalPaneTab(props: {
  readonly isActive: boolean;
  readonly onClose: () => void;
  readonly onSelect: () => void;
  readonly session: TerminalMenuSession;
  readonly theme: TerminalTheme;
}) {
  const { session, theme } = props;
  const isLive = session.status === "running" || session.status === "starting";
  const statusLabel = getTerminalStatusLabel({
    status: session.status,
    hasRunningSubprocess: session.hasRunningSubprocess,
  });

  return (
    <View
      className="h-9 flex-row items-center gap-1.5 rounded-lg pl-2.5 pr-1"
      style={{ backgroundColor: props.isActive ? theme.border : "transparent" }}
    >
      <Pressable
        accessibilityLabel={`${session.displayLabel}, ${statusLabel}`}
        accessibilityRole="tab"
        accessibilityState={{ selected: props.isActive }}
        className="h-9 flex-row items-center gap-1.5"
        onPress={props.onSelect}
      >
        <View
          className="size-1.5 rounded-full"
          style={{
            backgroundColor: isLive
              ? session.hasRunningSubprocess
                ? theme.foreground
                : theme.mutedForeground
              : theme.border,
          }}
        />
        <Text
          className="max-w-40 text-xs"
          numberOfLines={1}
          style={{ color: props.isActive ? theme.foreground : theme.mutedForeground }}
        >
          {session.displayLabel}
        </Text>
      </Pressable>
      <Pressable
        accessibilityLabel={`Close ${session.displayLabel}`}
        accessibilityRole="button"
        className="size-8 items-center justify-center"
        hitSlop={6}
        onPress={props.onClose}
      >
        <SymbolView
          name={{ ios: "xmark", android: "close" }}
          size={11}
          tintColor={theme.mutedForeground}
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}

function TerminalPaneAction(props: {
  readonly accessibilityLabel: string;
  readonly icon: AppSymbolName;
  readonly onPress: () => void;
  readonly theme: TerminalTheme;
}) {
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      className="size-11 items-center justify-center"
      onPress={props.onPress}
    >
      <SymbolView
        name={props.icon}
        size={15}
        tintColor={props.theme.mutedForeground}
        type="monochrome"
      />
    </Pressable>
  );
}

/**
 * The workspace terminal column: a tab strip over one attached pty.
 *
 * Sessions belong to the thread and live on the server, so switching tabs only
 * re-points the attach — background shells keep running. The full-screen
 * terminal route remains the compact-width surface and the maximize target.
 */
export function ThreadTerminalPane(props: {
  readonly activeTerminalId: string;
  /** False when the window is too short to split vertically. */
  readonly canDockBottom: boolean;
  readonly dockPosition: TerminalPaneDockPosition;
  readonly environmentId: EnvironmentId;
  readonly headerInset: number;
  readonly onClose: () => void;
  readonly onMaximize: () => void;
  readonly onSelectTerminal: (terminalId: string) => void;
  readonly onToggleDockPosition: () => void;
  readonly threadDetailWorktreePath: string | null;
  readonly threadId: ThreadId;
  readonly threadWorktreePath: string | null;
  readonly workspaceRoot: string;
}) {
  const { activeTerminalId, environmentId, onClose, onSelectTerminal, threadId, workspaceRoot } =
    props;
  const closeTerminal = useAtomCommand(terminalEnvironment.close, "terminal close");
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, "environment retry");
  const environment = useEnvironmentPresentation(environmentId);
  const isEnvironmentReady = environment.presentation?.connection.phase === "connected";
  const environmentLabel = environment.presentation?.entry.target.label ?? null;
  const {
    appearance,
    themeAppearance,
    themeId,
    isReady: hasResolvedFontPreference,
  } = useAppearancePreferences();
  const fontSize = appearance.terminalFontSize;
  const theme = getMobileTerminalTheme(themeId, themeAppearance);

  // An `exit` in the active shell falls through to a neighbouring live one;
  // the pane closes only when that was the last terminal.
  const tabsRef = useRef<ReadonlyArray<TerminalMenuSession>>([]);
  const handleSessionEnded = useCallback(
    (ended: { readonly terminalId: string }) => {
      if (ended.terminalId !== activeTerminalId) {
        return;
      }
      const fallbackTerminalId = previousLiveTerminalId({
        sessions: tabsRef.current,
        exitedTerminalId: ended.terminalId,
      });
      if (fallbackTerminalId === null) {
        onClose();
        return;
      }
      onSelectTerminal(fallbackTerminalId);
    },
    [activeTerminalId, onClose, onSelectTerminal],
  );

  const session = useThreadTerminalSession({
    enabled: true,
    environmentId,
    fontSize,
    hasResolvedFontPreference,
    isEnvironmentReady,
    onSessionEnded: handleSessionEnded,
    terminalId: activeTerminalId,
    threadDetailWorktreePath: props.threadDetailWorktreePath,
    threadId,
    threadWorktreePath: props.threadWorktreePath,
    workspaceRoot,
  });

  const tabs = useMemo(
    () =>
      buildTerminalMenuSessions({
        knownSessions: session.knownSessions,
        workspaceRoot,
        currentSession: {
          terminalId: activeTerminalId,
          cwd: session.cwd,
          status: session.terminal.status,
          hasRunningSubprocess: session.terminal.hasRunningSubprocess,
          displayLabel: resolveTerminalSessionLabel(activeTerminalId, session.terminal.summary),
          updatedAt: session.terminal.updatedAt,
        },
      }),
    [
      activeTerminalId,
      session.cwd,
      session.knownSessions,
      session.terminal.hasRunningSubprocess,
      session.terminal.status,
      session.terminal.summary,
      session.terminal.updatedAt,
      workspaceRoot,
    ],
  );

  tabsRef.current = tabs;

  const handleOpenNewTerminal = useCallback(() => {
    onSelectTerminal(
      nextOpenTerminalId({
        listedTerminalIds: tabs.map((tab) => tab.terminalId),
        activeRouteTerminalId: activeTerminalId,
      }),
    );
  }, [activeTerminalId, onSelectTerminal, tabs]);

  // Closing the active tab hands over to the neighbouring shell; the pane
  // closes only when this was the last one.
  const handleCloseTerminal = useCallback(
    (terminalId: string) => {
      void closeTerminal({ environmentId, input: { threadId, terminalId } });
      if (terminalId !== activeTerminalId) {
        return;
      }
      const fallbackTerminalId = previousLiveTerminalId({
        sessions: tabs,
        exitedTerminalId: terminalId,
      });
      if (fallbackTerminalId === null) {
        onClose();
        return;
      }
      onSelectTerminal(fallbackTerminalId);
    },
    [activeTerminalId, closeTerminal, environmentId, onClose, onSelectTerminal, tabs, threadId],
  );

  return (
    <View className="flex-1" style={{ backgroundColor: theme.background }}>
      <View style={{ height: props.headerInset }} />
      <View
        className="flex-row items-center gap-1 border-b px-1.5"
        style={{ borderBottomColor: theme.border, minHeight: TAB_STRIP_HEIGHT }}
      >
        <ScrollView
          horizontal
          className="flex-1"
          contentContainerClassName="items-center gap-1 pr-1"
          showsHorizontalScrollIndicator={false}
        >
          {tabs.map((tab) => (
            <TerminalPaneTab
              key={tab.terminalId}
              isActive={tab.terminalId === activeTerminalId}
              onClose={() => handleCloseTerminal(tab.terminalId)}
              onSelect={() => onSelectTerminal(tab.terminalId)}
              session={tab}
              theme={theme}
            />
          ))}
        </ScrollView>
        <TerminalPaneAction
          accessibilityLabel={`Open new terminal in ${basename(workspaceRoot) ?? "this workspace"}`}
          icon={{ ios: "plus", android: "add" }}
          onPress={handleOpenNewTerminal}
          theme={theme}
        />
        {props.canDockBottom || props.dockPosition === "bottom" ? (
          <TerminalPaneAction
            accessibilityLabel={
              props.dockPosition === "bottom" ? "Dock terminal to the right" : "Dock terminal below"
            }
            icon={
              props.dockPosition === "bottom"
                ? { ios: "sidebar.right", android: "view_sidebar" }
                : { ios: "rectangle.bottomthird.inset.filled", android: "bottom_panel_open" }
            }
            onPress={props.onToggleDockPosition}
            theme={theme}
          />
        ) : null}
        <TerminalPaneAction
          accessibilityLabel="Open terminal full screen"
          icon={{ ios: "arrow.up.left.and.arrow.down.right", android: "open_in_full" }}
          onPress={props.onMaximize}
          theme={theme}
        />
        <TerminalPaneAction
          accessibilityLabel="Close terminal pane"
          icon={{ ios: "xmark", android: "close" }}
          onPress={onClose}
          theme={theme}
        />
      </View>

      <View className="flex-1">
        {isEnvironmentReady ? (
          <TerminalSurfacePanel
            autoFocus={Platform.OS !== "android"}
            content={session.surfaceContent}
            keyboardMode={props.dockPosition === "bottom" ? "hosted" : "inset"}
            environmentLabel={environmentLabel}
            fontSize={fontSize}
            isRunning={session.isRunning}
            onClear={session.clearTerminal}
            onInput={session.sendInput}
            onResize={session.handleResize}
            onToggleModifier={session.togglePendingModifier}
            pendingModifier={session.pendingModifier}
            terminalKey={session.terminalKey}
            theme={theme}
          />
        ) : (
          <EnvironmentConnectionNotice
            environmentLabel={environmentLabel ?? "Environment"}
            connection={
              environment.presentation?.connection ?? {
                phase: "available",
                error: null,
                traceId: null,
              }
            }
            resourceName="terminal"
            onRetry={() => void retryEnvironment(environmentId)}
          />
        )}
      </View>
    </View>
  );
}
