import * as Clipboard from "expo-clipboard";
import { Alert } from "react-native";
import { chunkTerminalWrite } from "./terminalInput";
import { createTerminalPasteSession } from "./terminalPaste";
import {
  terminalOutputText,
  type KnownTerminalSession,
} from "@t3tools/client-runtime/state/terminal";
import { DEFAULT_TERMINAL_ID, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  useAttachedTerminalSession,
  useKnownTerminalSessions,
} from "../../state/use-terminal-session";
import { terminalDebugLog } from "./terminalDebugLog";
import {
  resolveTerminalOpenLocation,
  takePendingTerminalLaunch,
  type PendingTerminalLaunch,
} from "./terminalLaunchContext";
import { cacheTerminalGridSize, getCachedTerminalGridSize } from "./terminalUiState";

export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;

export type TerminalPendingModifier = "ctrl" | "meta";

export function applyCtrlModifier(input: string): string {
  const firstCharacter = input[0];
  if (!firstCharacter) {
    return input;
  }

  const lowerCharacter = firstCharacter.toLowerCase();
  if (lowerCharacter >= "a" && lowerCharacter <= "z") {
    return String.fromCharCode(lowerCharacter.charCodeAt(0) - 96);
  }

  if (firstCharacter === "@") return "\u0000";
  if (firstCharacter === "[") return "\u001b";
  if (firstCharacter === "\\") return "\u001c";
  if (firstCharacter === "]") return "\u001d";
  if (firstCharacter === "^") return "\u001e";
  if (firstCharacter === "_") return "\u001f";
  if (firstCharacter === "?") return "\u007f";

  return input;
}

/** The session a terminal surface adopts when the caller did not name one. */
export function pickRunningTerminalSessionForBootstrap(
  sessions: ReadonlyArray<KnownTerminalSession>,
): KnownTerminalSession | null {
  const running = sessions.filter(
    (session) => session.state.status === "running" || session.state.status === "starting",
  );
  if (running.length === 0) {
    return null;
  }
  return (
    running.find((session) => session.target.terminalId === DEFAULT_TERMINAL_ID) ??
    running[0] ??
    null
  );
}

export interface ThreadTerminalSessionInput {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly terminalId: string;
  readonly workspaceRoot: string | null;
  readonly threadWorktreePath: string | null;
  readonly threadDetailWorktreePath: string | null;
  readonly fontSize: number;
  readonly hasResolvedFontPreference: boolean;
  readonly isEnvironmentReady: boolean;
  /**
   * False while this terminal must not hold a pty: a hidden surface, or a
   * host that is about to swap to another session. Detaching stops the
   * attach subscription; the session itself keeps running on the server.
   */
  readonly enabled: boolean;
  /**
   * The pty ended (`exit`, a crash, or a close from elsewhere). The session
   * is already closed by the time this fires; hosts decide where to go next.
   */
  readonly onSessionEnded: (input: { readonly terminalId: string }) => void;
}

/**
 * Owns one attached terminal session: launch location, attach lifecycle,
 * buffer replay, input, resize, and end-of-session cleanup.
 *
 * Shared by the full-screen terminal route and the workspace terminal pane so
 * both surfaces attach, respawn, and exit identically — only navigation and
 * chrome differ between them.
 */
export function useThreadTerminalSession(input: ThreadTerminalSessionInput) {
  const {
    enabled,
    environmentId,
    hasResolvedFontPreference,
    isEnvironmentReady,
    terminalId,
    threadId,
    threadDetailWorktreePath,
    threadWorktreePath,
    workspaceRoot,
  } = input;
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const resizeTerminal = useAtomCommand(terminalEnvironment.resize, "terminal resize");
  const clearTerminalCommand = useAtomCommand(terminalEnvironment.clear, "terminal clear");
  const closeTerminal = useAtomCommand(terminalEnvironment.close, "terminal close");
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const onSessionEndedRef = useRef(input.onSessionEnded);
  onSessionEndedRef.current = input.onSessionEnded;

  const knownSessions = useKnownTerminalSessions({ environmentId, threadId });
  const activeKnownSession = useMemo(
    () => knownSessions.find((session) => session.target.terminalId === terminalId) ?? null,
    [knownSessions, terminalId],
  );
  const cachedGridSize =
    environmentId && threadId
      ? getCachedTerminalGridSize({ environmentId, threadId, terminalId })
      : null;
  const launchTarget = useMemo(
    () => (environmentId && threadId ? { environmentId, threadId, terminalId } : null),
    [environmentId, terminalId, threadId],
  );
  const launchTargetKey = launchTarget
    ? `${launchTarget.environmentId}:${launchTarget.threadId}:${launchTarget.terminalId}`
    : null;
  const [pendingLaunchEntry, setPendingLaunchEntry] = useState<{
    readonly key: string | null;
    readonly launch: PendingTerminalLaunch | null;
  }>(() => ({
    key: launchTargetKey,
    launch: launchTarget === null ? null : takePendingTerminalLaunch(launchTarget),
  }));
  const pendingLaunch =
    pendingLaunchEntry.key === launchTargetKey ? pendingLaunchEntry.launch : null;
  const hasResolvedPendingLaunch = pendingLaunchEntry.key === launchTargetKey;
  const [initialAttachGridEntry, setInitialAttachGridEntry] = useState(() => ({
    key: launchTargetKey,
    size: cachedGridSize ?? { cols: DEFAULT_TERMINAL_COLS, rows: DEFAULT_TERMINAL_ROWS },
  }));
  const initialAttachGridSize =
    initialAttachGridEntry.key === launchTargetKey ? initialAttachGridEntry.size : null;
  const [lastGridSize, setLastGridSize] = useState(
    cachedGridSize ?? { cols: DEFAULT_TERMINAL_COLS, rows: DEFAULT_TERMINAL_ROWS },
  );
  const [pendingModifierState, setPendingModifierState] = useState<{
    readonly terminalId: string;
    readonly value: TerminalPendingModifier | null;
  }>({ terminalId, value: null });
  const firstNonEmptyBufferLoggedRef = useRef(false);
  const sentInitialInputKeyRef = useRef<string | null>(null);
  /** Default grid is always valid for attach; onResize refines cols/rows. */
  const [hasMeasuredSurface, setHasMeasuredSurface] = useState(true);

  const launchLocationCandidate = useMemo(() => {
    if (!workspaceRoot) {
      return null;
    }
    if (pendingLaunch) {
      return { cwd: pendingLaunch.cwd, worktreePath: pendingLaunch.worktreePath };
    }
    return resolveTerminalOpenLocation({
      terminalLocation: activeKnownSession?.state.summary ?? null,
      activeSessionLocation: activeKnownSession?.state.summary ?? null,
      workspaceRoot,
      threadShellWorktreePath: threadWorktreePath,
      threadDetailWorktreePath,
    });
  }, [
    activeKnownSession?.state.summary,
    pendingLaunch,
    threadDetailWorktreePath,
    threadWorktreePath,
    workspaceRoot,
  ]);
  const [initialLaunchLocationEntry, setInitialLaunchLocationEntry] = useState(() => ({
    key: launchTargetKey,
    location: launchLocationCandidate,
  }));
  const launchLocation =
    initialLaunchLocationEntry.key === launchTargetKey ? initialLaunchLocationEntry.location : null;

  const terminalAttachInput = useMemo(
    () =>
      enabled &&
      threadId !== null &&
      launchLocation !== null &&
      hasResolvedPendingLaunch &&
      initialAttachGridSize !== null &&
      hasResolvedFontPreference &&
      hasMeasuredSurface &&
      isEnvironmentReady
        ? {
            threadId,
            terminalId,
            cwd: launchLocation.cwd,
            worktreePath: launchLocation.worktreePath,
            cols: initialAttachGridSize.cols,
            rows: initialAttachGridSize.rows,
            ...(pendingLaunch?.env ? { env: pendingLaunch.env } : {}),
            ...(pendingLaunch ? { restartIfNotRunning: true } : {}),
          }
        : null,
    [
      enabled,
      hasMeasuredSurface,
      hasResolvedFontPreference,
      hasResolvedPendingLaunch,
      initialAttachGridSize,
      isEnvironmentReady,
      launchLocation,
      pendingLaunch,
      terminalId,
      threadId,
    ],
  );
  const terminal = useAttachedTerminalSession({ environmentId, terminal: terminalAttachInput });
  const terminalKey =
    environmentId && threadId ? `${environmentId}:${threadId}:${terminalId}` : terminalId;
  const surfaceContent = useMemo(() => ({ output: terminal.output }), [terminal.output]);
  const isRunning = terminal.status === "running" || terminal.status === "starting";
  const runningTerminalKeyRef = useRef<string | null>(null);
  const reopenedStaleTerminalKeyRef = useRef<string | null>(null);

  // Attach subscriptions are cached with an idle TTL, so revisiting a
  // terminal whose session ended while unobserved reuses the stale stream
  // without a new attach RPC — the server never respawns anything. Detect
  // that (dead status with processed events, never seen running here) and
  // issue an explicit open; its snapshot flows into the live subscription.
  useEffect(() => {
    if (isRunning) {
      reopenedStaleTerminalKeyRef.current = null;
      return;
    }
    if (
      terminalAttachInput === null ||
      environmentId === null ||
      threadId === null ||
      (terminal.status !== "closed" && terminal.status !== "exited") ||
      terminal.version === 0 ||
      runningTerminalKeyRef.current === terminalKey ||
      reopenedStaleTerminalKeyRef.current === terminalKey
    ) {
      return;
    }
    reopenedStaleTerminalKeyRef.current = terminalKey;
    void openTerminal({
      environmentId,
      input: {
        threadId,
        terminalId,
        cwd: terminalAttachInput.cwd,
        worktreePath: terminalAttachInput.worktreePath,
        cols: terminalAttachInput.cols,
        rows: terminalAttachInput.rows,
        ...(terminalAttachInput.env ? { env: terminalAttachInput.env } : {}),
      },
    }).then((result) => {
      // Release the guard on failure so a later render can retry the respawn.
      if (result._tag === "Failure" && reopenedStaleTerminalKeyRef.current === terminalKey) {
        reopenedStaleTerminalKeyRef.current = null;
      }
    });
  }, [
    environmentId,
    isRunning,
    openTerminal,
    terminal.status,
    terminal.version,
    terminalAttachInput,
    terminalId,
    terminalKey,
    threadId,
  ]);

  useEffect(() => {
    terminalDebugLog("session:status", {
      terminalKey,
      status: terminal.status,
      error: terminal.error,
      summary: terminal.summary?.cwd ?? null,
      retainedBytes: terminal.output.retainedBytes,
      version: terminal.version,
    });
  }, [
    terminal.output.retainedBytes,
    terminal.error,
    terminal.status,
    terminal.summary?.cwd,
    terminal.version,
    terminalKey,
  ]);

  useEffect(() => {
    if (terminal.output.retainedBytes === 0 || firstNonEmptyBufferLoggedRef.current) {
      return;
    }
    firstNonEmptyBufferLoggedRef.current = true;
    const text = terminalOutputText(terminal.output);
    terminalDebugLog("session:first-nonempty-buffer", {
      terminalKey,
      length: text.length,
      preview: text.slice(0, 160),
    });
  }, [terminal.output, terminalKey]);

  useEffect(() => {
    if (pendingLaunchEntry.key === launchTargetKey) {
      return;
    }
    setPendingLaunchEntry({
      key: launchTargetKey,
      launch: launchTarget === null ? null : takePendingTerminalLaunch(launchTarget),
    });
  }, [launchTarget, launchTargetKey, pendingLaunchEntry.key]);

  useEffect(() => {
    if (initialAttachGridEntry.key === launchTargetKey) {
      return;
    }
    setInitialAttachGridEntry({
      key: launchTargetKey,
      size: cachedGridSize ?? { cols: DEFAULT_TERMINAL_COLS, rows: DEFAULT_TERMINAL_ROWS },
    });
  }, [cachedGridSize, initialAttachGridEntry.key, launchTargetKey]);

  useEffect(() => {
    if (
      initialLaunchLocationEntry.key === launchTargetKey &&
      initialLaunchLocationEntry.location !== null
    ) {
      return;
    }
    if (initialLaunchLocationEntry.key === launchTargetKey && launchLocationCandidate === null) {
      return;
    }
    setInitialLaunchLocationEntry({ key: launchTargetKey, location: launchLocationCandidate });
  }, [
    initialLaunchLocationEntry.key,
    initialLaunchLocationEntry.location,
    launchLocationCandidate,
    launchTargetKey,
  ]);

  useEffect(() => {
    const initialInput = pendingLaunch?.initialInput;
    if (
      !initialInput ||
      environmentId === null ||
      threadId === null ||
      terminal.version === 0 ||
      sentInitialInputKeyRef.current === launchTargetKey
    ) {
      return;
    }
    sentInitialInputKeyRef.current = launchTargetKey;
    void writeTerminal({
      environmentId,
      input: { threadId, terminalId, data: initialInput },
    });
  }, [
    environmentId,
    launchTargetKey,
    pendingLaunch?.initialInput,
    terminal.version,
    terminalId,
    threadId,
    writeTerminal,
  ]);

  useEffect(() => {
    firstNonEmptyBufferLoggedRef.current = false;
    sentInitialInputKeyRef.current = null;
  }, [terminalKey]);

  useEffect(() => {
    if (!environmentId || !threadId) {
      setLastGridSize({ cols: DEFAULT_TERMINAL_COLS, rows: DEFAULT_TERMINAL_ROWS });
      return;
    }
    setLastGridSize(
      getCachedTerminalGridSize({ environmentId, threadId, terminalId }) ?? {
        cols: DEFAULT_TERMINAL_COLS,
        rows: DEFAULT_TERMINAL_ROWS,
      },
    );
    setHasMeasuredSurface(true);
  }, [environmentId, terminalId, threadId]);

  const inputGeneration = useRef(0);
  useEffect(() => {
    inputGeneration.current += 1;
    return () => {
      inputGeneration.current += 1;
    };
  }, [enabled, isRunning, terminal.lifecycleVersion, terminalKey]);

  const writeInput = useCallback(
    async (data: string) => {
      if (environmentId === null || threadId === null || !isRunning || !enabled) return false;
      const generation = inputGeneration.current;
      for (const chunk of chunkTerminalWrite(data)) {
        if (generation !== inputGeneration.current) return false;
        const result = await writeTerminal({
          environmentId,
          input: { threadId, terminalId, data: chunk },
        });
        if (result._tag === "Failure") return false;
      }
      return true;
    },
    [enabled, environmentId, isRunning, terminalId, threadId, writeTerminal],
  );

  const [pasteSession] = useState(createTerminalPasteSession);
  useEffect(() => {
    pasteSession.reset(isRunning && enabled);
    return () => pasteSession.reset(false);
  }, [enabled, isRunning, pasteSession, terminal.lifecycleVersion, terminalKey]);
  const pasteFromClipboard = useCallback(
    () =>
      pasteSession.paste({
        readText: Clipboard.getStringAsync,
        write: writeInput,
        onReadError: () => Alert.alert("Could not read clipboard"),
      }),
    [pasteSession, writeInput],
  );

  const pendingModifier =
    pendingModifierState.terminalId === terminalId ? pendingModifierState.value : null;

  /** Writes `data` through the armed modifier (if any) and disarms it. */
  const sendInput = useCallback(
    (data: string) => {
      if (data.length === 0) {
        return;
      }
      // Keystrokes are the hot path: only touch state when a modifier is
      // actually armed, so plain typing never re-renders the surface.
      if (pendingModifier === null) {
        writeInput(data);
        return;
      }
      setPendingModifierState({ terminalId, value: null });
      writeInput(pendingModifier === "ctrl" ? applyCtrlModifier(data) : `\u001b${data}`);
    },
    [pendingModifier, terminalId, writeInput],
  );

  const togglePendingModifier = useCallback(
    (modifier: TerminalPendingModifier) => {
      setPendingModifierState((current) => ({
        terminalId,
        value:
          (current.terminalId === terminalId ? current.value : null) === modifier ? null : modifier,
      }));
    },
    [terminalId],
  );

  const clearTerminal = useCallback(() => {
    if (environmentId === null || threadId === null) {
      return;
    }
    setPendingModifierState({ terminalId, value: null });
    void clearTerminalCommand({
      environmentId,
      input: { threadId, terminalId },
    });
  }, [clearTerminalCommand, environmentId, terminalId, threadId]);

  // Layout can arrive before attach finishes. Send that measurement once the
  // shell is ready rather than leaving it at the initial 80-column fallback.
  useEffect(() => {
    if (!enabled || !isRunning || environmentId === null || threadId === null) return;
    void resizeTerminal({
      environmentId,
      input: { threadId, terminalId, cols: lastGridSize.cols, rows: lastGridSize.rows },
    });
  }, [
    enabled,
    environmentId,
    isRunning,
    lastGridSize.cols,
    lastGridSize.rows,
    resizeTerminal,
    terminalId,
    threadId,
  ]);

  const handleResize = useCallback(
    (size: { readonly cols: number; readonly rows: number }) => {
      terminalDebugLog("native:onResize", { cols: size.cols, rows: size.rows, terminalKey });
      setHasMeasuredSurface(true);
      if (environmentId && threadId) {
        cacheTerminalGridSize({ environmentId, threadId, terminalId }, size);
      }
      if (size.cols === lastGridSize.cols && size.rows === lastGridSize.rows) {
        return;
      }
      setLastGridSize(size);
    },
    [environmentId, lastGridSize.cols, lastGridSize.rows, terminalId, terminalKey, threadId],
  );

  // When the process ends while attached (e.g. typing `exit`), close the
  // session and hand control back to the host, mirroring the web drawer's
  // onSessionExited flow. Only a running -> exited transition observed here
  // counts, so an already-exited session can still be opened (it restarts on
  // attach).
  useEffect(() => {
    // Detached (hidden surface or environment drop): forget the running
    // marker so a reattach takes the stale-reopen path instead of misreading
    // the dead snapshot as an exit observed here.
    if (terminalAttachInput === null) {
      runningTerminalKeyRef.current = null;
      return;
    }
    if (isRunning) {
      runningTerminalKeyRef.current = terminalKey;
      return;
    }
    // The web drawer treats both exited and closed as session end.
    const sessionEnded = terminal.status === "exited" || terminal.status === "closed";
    if (!sessionEnded || runningTerminalKeyRef.current !== terminalKey) {
      return;
    }
    runningTerminalKeyRef.current = null;
    // Mark this key handled so the stale-attach effect doesn't respawn the
    // session the user just ended.
    reopenedStaleTerminalKeyRef.current = terminalKey;
    if (environmentId !== null && threadId !== null) {
      void closeTerminal({
        environmentId,
        input: { threadId, terminalId },
      });
    }
    onSessionEndedRef.current({ terminalId });
  }, [
    closeTerminal,
    environmentId,
    isRunning,
    terminal.status,
    terminalAttachInput,
    terminalId,
    terminalKey,
    threadId,
  ]);

  return {
    clearTerminal,
    cwd: terminal.summary?.cwd ?? workspaceRoot ?? null,
    handleResize,
    isRunning,
    knownSessions,
    pendingModifier,
    pasteFromClipboard,
    sendInput,
    surfaceContent,
    terminal,
    terminalKey,
    togglePendingModifier,
    writeInput,
  };
}
