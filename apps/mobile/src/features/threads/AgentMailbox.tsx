import { getMailboxThreadCandidates } from "@t3tools/client-runtime/state/mailbox-candidates";
import { formatMailboxConversationExport } from "@t3tools/client-runtime/state/mailbox-export";
import {
  formatMailboxTime,
  getMailboxConversationMessages,
  getMailboxThreadStatus,
  mailboxMessageStatus,
  mailboxTurnStatus,
  type MailboxStatus,
  type MailboxStatusTone,
} from "@t3tools/client-runtime/state/mailbox-presentation";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  CommandId,
  type EnvironmentId,
  type MailboxGetInput,
  type MailboxUpdateInput,
  type ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommonActions, useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";
import * as Crypto from "expo-crypto";
import { AppText as Text, AppTextInput } from "../../components/AppText";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useProjects, useThreadShells } from "../../state/entities";
import { mailboxEnvironment } from "../../state/mailbox";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { shareGeneratedTextFile } from "../../lib/attachmentDownload";

const ThemedSafeAreaView = withUniwind(SafeAreaView);
const statusClasses: Record<MailboxStatusTone, { container: string; text: string }> = {
  neutral: { container: "bg-subtle-strong", text: "text-foreground-secondary" },
  info: { container: "bg-update", text: "text-update-foreground" },
  warning: { container: "bg-warning", text: "text-warning-foreground" },
  error: { container: "bg-danger", text: "text-danger-foreground" },
  success: { container: "bg-subtle-strong", text: "text-foreground" },
};

function StatusBadge({ status }: { status: MailboxStatus }) {
  const classes = statusClasses[status.tone];
  return (
    <View className={`self-start rounded-md px-2 py-1 ${classes.container}`}>
      <Text className={`text-xs font-t3-medium ${classes.text}`}>{status.label}</Text>
    </View>
  );
}

function MailboxAction(props: {
  label: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ disabled: props.disabled ?? false }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-11 shrink-0 items-center justify-center px-3 disabled:opacity-50"
    >
      <Text className="text-sm font-t3-medium text-primary-text">{props.label}</Text>
    </Pressable>
  );
}

function ThreadIdentity(props: {
  thread: EnvironmentThreadShell | undefined;
  project: string | undefined;
}) {
  return (
    <View className="min-w-0 gap-1">
      <Text className="text-base font-t3-medium">
        {props.thread?.title ?? "Unavailable thread"}
      </Text>
      {props.project ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.project}
        </Text>
      ) : null}
      <StatusBadge status={getMailboxThreadStatus(props.thread)} />
    </View>
  );
}

interface MailboxProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  pendingCount: number;
  revision: number;
}

export function AgentMailboxSheet(props: MailboxProps & { open: boolean; close: () => void }) {
  return (
    <Modal
      visible={props.open}
      animationType="slide"
      presentationStyle="pageSheet"
      allowSwipeDismissal
      onRequestClose={props.close}
    >
      {props.open ? (
        <SafeAreaProvider>
          <MailboxContents {...props} />
        </SafeAreaProvider>
      ) : null}
    </Modal>
  );
}

function MailboxContents({
  environmentId,
  threadId,
  pendingCount,
  revision,
  close,
}: MailboxProps & { close: () => void }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [candidateLimit, setCandidateLimit] = useState(8);
  const [before, setBefore] = useState<MailboxGetInput["before"]>();
  const [executionId, setExecutionId] = useState<MailboxGetInput["executionId"]>();
  const [beforeTurn, setBeforeTurn] = useState<MailboxGetInput["beforeTurn"]>();
  const [messageId, setMessageId] = useState<MailboxGetInput["messageId"]>();
  const [peerThreadId, setPeerThreadId] = useState<MailboxGetInput["peerThreadId"]>();
  const [messageSearch, setMessageSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [exporting, setExporting] = useState(false);
  const exportController = useRef<AbortController | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const { themeAppearance } = useAppearancePreferences();
  const threads = useThreadShells();
  const projects = useProjects();
  const navigation = useNavigation();
  const query = useEnvironmentQuery(
    mailboxEnvironment.detail({
      environmentId,
      input: {
        threadId,
        ...(before ? { before } : {}),
        ...(executionId ? { executionId } : {}),
        ...(beforeTurn ? { beforeTurn } : {}),
        ...(messageId ? { messageId } : {}),
        ...(peerThreadId ? { peerThreadId } : {}),
        ...(appliedSearch ? { search: appliedSearch } : {}),
      },
    }),
  );
  const update = useAtomCommand(mailboxEnvironment.update);
  const exportConversation = useAtomCommand(mailboxEnvironment.exportConversation);
  useEffect(() => () => exportController.current?.abort(), []);
  const refresh = query.refresh;
  useEffect(() => {
    if (revision >= 0) refresh();
  }, [revision, refresh]);
  const threadById = useMemo(
    () =>
      new Map(
        threads
          .filter((entry) => entry.environmentId === environmentId)
          .map((entry) => [entry.id, entry]),
      ),
    [threads, environmentId],
  );
  const projectById = useMemo(
    () =>
      new Map(
        projects
          .filter((entry) => entry.environmentId === environmentId)
          .map((entry) => [entry.id, entry]),
      ),
    [projects, environmentId],
  );
  const projectName = (thread: EnvironmentThreadShell | undefined) =>
    thread ? (projectById.get(thread.projectId)?.title ?? "Project") : undefined;
  const mutate = async (operation: MailboxUpdateInput["operation"]) => {
    setBusy(true);
    try {
      const result = await update({
        environmentId,
        input: { threadId, commandId: CommandId.make(Crypto.randomUUID()), operation },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        setMutationError(
          error instanceof Error && error.message.trim()
            ? error.message
            : "The mailbox could not be updated. Try again.",
        );
        return;
      }
      setMutationError(null);
      refresh();
    } finally {
      setBusy(false);
    }
  };
  const openThread = (id: ThreadId) => {
    if (!threadById.has(id)) return;
    close();
    navigation.dispatch(CommonActions.navigate("Thread", { environmentId, threadId: id }));
  };
  const linkedThreadIds = query.data?.peers;
  const peers = linkedThreadIds ?? [];
  const candidates = useMemo(
    () =>
      linkedThreadIds === undefined
        ? []
        : getMailboxThreadCandidates({
            threads,
            projects,
            environmentId,
            threadId,
            linkedThreadIds,
            search,
          }),
    [threads, projects, environmentId, threadId, linkedThreadIds, search],
  );
  const visibleCandidates = candidates.slice(0, candidateLimit);
  const showPicker = pickerOpen || (linkedThreadIds !== undefined && peers.length === 0);
  const autoWake = query.data?.autoWake;
  const messages = useMemo(
    () =>
      peerThreadId
        ? getMailboxConversationMessages(query.data?.messages ?? [], threadId, peerThreadId)
        : (query.data?.messages ?? []),
    [query.data?.messages, threadId, peerThreadId],
  );
  const turns = query.data?.turns ?? [];
  const waitingCount = query.data?.pendingCount ?? (peerThreadId ? 0 : pendingCount);
  const showConversation = (id: ThreadId | undefined) => {
    setMessageSearch("");
    setAppliedSearch("");
    setBefore(undefined);
    setMessageId(undefined);
    setPeerThreadId(id);
  };
  const showMessage = (id: string) => {
    setMessageSearch("");
    setAppliedSearch("");
    setBefore(undefined);
    setPeerThreadId(undefined);
    setMessageId(id);
  };
  const applyMessageSearch = (value = messageSearch) => {
    setBefore(undefined);
    setMessageSearch(value);
    setAppliedSearch(value.trim());
  };
  const shareConversation = async () => {
    if (!peerThreadId || exporting) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setMutationError(null);
    try {
      const result = await exportConversation({ environmentId, input: { threadId, peerThreadId } });
      if (controller.signal.aborted) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const participant = (id: ThreadId) => {
        const thread = threadById.get(id);
        return {
          threadId: id,
          title: thread?.title ?? "Unavailable thread",
          project: projectName(thread) ?? null,
        };
      };
      const { filename, contents } = formatMailboxConversationExport({
        participants: [participant(threadId), participant(peerThreadId)],
        messages: result.value,
        exportedAt: new Date().toISOString(),
      });
      await shareGeneratedTextFile({
        name: filename,
        mimeType: "application/json",
        contents,
        signal: controller.signal,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setMutationError(
          error instanceof Error ? error.message : "Could not export the conversation. Try again.",
        );
      }
    } finally {
      exportController.current = null;
      if (!controller.signal.aborted) setExporting(false);
    }
  };

  return (
    <ThemedSafeAreaView className="flex-1 bg-sheet-solid">
      <View className="flex-row items-center justify-between gap-2 border-b border-border px-4 py-2">
        <Text className="flex-1 text-lg font-t3-bold">
          {peerThreadId ? "Conversation" : "Agent mailbox"}
        </Text>
        <MailboxAction label="Refresh" disabled={query.isPending} onPress={refresh} />
        <MailboxAction label="Done" accessibilityLabel="Close mailbox" onPress={close} />
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 24 }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {peerThreadId ? (
          <View className="gap-2">
            <Text className="font-t3-medium">
              {threadById.get(threadId)?.title ?? "This thread"} ↔{" "}
              {threadById.get(peerThreadId)?.title ?? "Unavailable thread"}
            </Text>
            <StatusBadge status={getMailboxThreadStatus(threadById.get(peerThreadId))} />
          </View>
        ) : (
          <Text className="text-sm text-foreground-muted">
            Linked threads can message each other. A message wakes an idle agent; a busy agent sees
            it once its turn ends.
          </Text>
        )}
        {mutationError || query.error ? (
          <View className="rounded-lg bg-danger p-3">
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {mutationError ?? query.error}
            </Text>
          </View>
        ) : null}
        {!peerThreadId ? (
          <View className="gap-3">
            <View className="flex-row items-center justify-between gap-2">
              <Text className="flex-1 font-t3-bold">Linked threads ({peers.length})</Text>
              {peers.length > 0 ? (
                <MailboxAction
                  label={pickerOpen ? "Done linking" : "Link a thread"}
                  onPress={() => setPickerOpen((value) => !value)}
                />
              ) : null}
            </View>
            {peers.map((id) => {
              const thread = threadById.get(id);
              return (
                <View key={id} className="gap-2 rounded-lg border border-border bg-card p-3">
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel={`Open ${thread?.title ?? "unavailable thread"}`}
                    disabled={!thread}
                    className="min-w-0 py-1"
                    onPress={() => openThread(id)}
                  >
                    <ThreadIdentity thread={thread} project={projectName(thread)} />
                  </Pressable>
                  <View className="flex-row flex-wrap justify-end">
                    <MailboxAction
                      label="Conversation"
                      accessibilityLabel={`View conversation with ${thread?.title ?? "unavailable thread"}`}
                      onPress={() => showConversation(id)}
                    />
                    <MailboxAction
                      label="Unlink"
                      accessibilityLabel={`Unlink ${thread?.title ?? "unavailable thread"}`}
                      disabled={busy}
                      onPress={() => void mutate({ kind: "link", peerThreadId: id, linked: false })}
                    />
                  </View>
                </View>
              );
            })}
            {linkedThreadIds !== undefined && peers.length === 0 ? (
              <Text className="text-sm text-foreground-muted">
                Nothing linked yet. Pick a thread below so the two agents can message each other.
              </Text>
            ) : null}
            {showPicker ? (
              <View className="gap-3 rounded-lg border border-border bg-subtle p-3">
                <AppTextInput
                  accessibilityLabel="Find a thread to link"
                  placeholder="Find a project or unsettled thread…"
                  keyboardAppearance={themeAppearance}
                  autoCorrect={false}
                  value={search}
                  onChangeText={(value) => {
                    setSearch(value);
                    setCandidateLimit(8);
                  }}
                />
                <Text className="text-sm text-foreground-muted">
                  Available unsettled threads ({candidates.length})
                </Text>
                {visibleCandidates.map((thread) => (
                  <View
                    key={thread.id}
                    className="flex-row items-center gap-2 rounded-lg border border-border bg-card p-3"
                  >
                    <View className="min-w-0 flex-1">
                      <ThreadIdentity thread={thread} project={projectName(thread)} />
                    </View>
                    <MailboxAction
                      label="Link"
                      accessibilityLabel={`Link ${thread.title}`}
                      disabled={busy}
                      onPress={() =>
                        void mutate({ kind: "link", peerThreadId: thread.id, linked: true })
                      }
                    />
                  </View>
                ))}
                {linkedThreadIds !== undefined && candidates.length === 0 ? (
                  <Text className="text-sm text-foreground-muted">
                    {search.trim()
                      ? "No matching unsettled threads in this environment."
                      : "No other unsettled threads available to link."}
                  </Text>
                ) : null}
                {candidates.length > candidateLimit ? (
                  <MailboxAction
                    label={`Show ${candidates.length - candidateLimit} more`}
                    onPress={() => setCandidateLimit((limit) => limit + 8)}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}
        {autoWake && !peerThreadId ? (
          <View className="flex-row items-center gap-4 rounded-lg border border-border bg-card p-3">
            <View className="min-w-0 flex-1 gap-1">
              <Text className="font-t3-medium">Wake this agent on new mail</Text>
              <Text className="text-sm text-foreground-muted">
                {autoWake.enabled
                  ? "A message starts a turn when this thread is idle."
                  : (autoWake.reason ?? "Messages queue until you send the next turn.")}
              </Text>
            </View>
            <ThemedSwitch
              accessibilityLabel="Wake this agent on new mail"
              value={autoWake.enabled}
              disabled={busy}
              onValueChange={(enabled) => void mutate({ kind: "auto-wake", enabled })}
            />
          </View>
        ) : null}
        <View className="gap-3">
          <View className="flex-row flex-wrap items-center justify-between gap-2">
            <Text className="font-t3-bold">{peerThreadId ? "Message history" : "Messages"}</Text>
            {waitingCount > 0 ? (
              <StatusBadge status={{ label: `${waitingCount} waiting`, tone: "warning" }} />
            ) : null}
            {messageId || peerThreadId ? (
              <MailboxAction label="All messages" onPress={() => showConversation(undefined)} />
            ) : null}
          </View>
          {peerThreadId ? (
            <View className="gap-2">
              <AppTextInput
                accessibilityLabel="Search conversation messages"
                placeholder="Search messages…"
                value={messageSearch}
                maxLength={500}
                onChangeText={setMessageSearch}
                onSubmitEditing={() => applyMessageSearch()}
                returnKeyType="search"
                keyboardAppearance={themeAppearance}
                className="rounded-lg border border-border bg-card px-3 py-3 text-base"
              />
              <View className="flex-row flex-wrap justify-end">
                <MailboxAction label="Search" onPress={() => applyMessageSearch()} />
                {appliedSearch || messageSearch ? (
                  <MailboxAction label="Clear" onPress={() => applyMessageSearch("")} />
                ) : null}
                <MailboxAction
                  label={exporting ? "Exporting…" : "Export JSON"}
                  disabled={exporting}
                  onPress={() => void shareConversation()}
                />
              </View>
              {appliedSearch ? (
                <Text className="text-sm text-foreground-muted">
                  Results for “{appliedSearch}” across this conversation.
                </Text>
              ) : null}
            </View>
          ) : null}
          {peerThreadId ? (
            <Text className="text-sm text-foreground-muted">
              {appliedSearch
                ? "Matching messages, oldest first."
                : before
                  ? "Older messages, oldest first."
                  : "Latest messages, oldest first."}{" "}
              Opening this history does not mark messages as read by the agent.
            </Text>
          ) : null}
          {query.isPending && !query.data ? (
            <Text className="text-foreground-muted">Loading mailbox…</Text>
          ) : null}
          {query.data && messages.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              {appliedSearch
                ? "No messages match your search."
                : peerThreadId
                  ? "No messages between these threads yet."
                  : peers.length === 0
                    ? "Link a thread to start exchanging messages."
                    : "No messages between this thread and its links yet."}
            </Text>
          ) : null}
          {messages.map((message) => {
            const outgoing = message.fromThreadId === threadId;
            const peerId = outgoing ? message.toThreadId : message.fromThreadId;
            const displayedThreadId = peerThreadId ? message.fromThreadId : peerId;
            const displayedThread = threadById.get(displayedThreadId);
            const incomingOpen =
              !outgoing && message.state !== "resolved" && message.state !== "dismissed";
            return (
              <View
                key={message.id}
                className={
                  peerThreadId
                    ? outgoing
                      ? "ml-6 gap-3 rounded-lg border border-border bg-update p-3"
                      : "mr-6 gap-3 rounded-lg border border-border bg-card p-3"
                    : "gap-3 rounded-lg border border-border bg-card p-3"
                }
              >
                <Text className="text-xs text-foreground-muted">
                  {peerThreadId ? "From" : outgoing ? "To" : "From"}
                </Text>
                <Pressable
                  accessibilityRole="link"
                  disabled={!displayedThread}
                  onPress={() => openThread(displayedThreadId)}
                >
                  <ThreadIdentity thread={displayedThread} project={projectName(displayedThread)} />
                </Pressable>
                <View className="flex-row flex-wrap items-center justify-between gap-2">
                  <StatusBadge status={mailboxMessageStatus[message.state]} />
                  <Text className="text-xs text-foreground-muted">
                    {formatMailboxTime(message.createdAt)}
                  </Text>
                </View>
                {message.replyTo ? (
                  <MailboxAction
                    label="View replied-to message"
                    onPress={() => showMessage(message.replyTo!)}
                  />
                ) : null}
                <Text selectable>{message.body}</Text>
                {message.updatedAt !== message.createdAt ? (
                  <Text className="text-xs text-foreground-muted">
                    State updated {formatMailboxTime(message.updatedAt)}
                  </Text>
                ) : null}
                <View className="flex-row flex-wrap justify-end">
                  {!peerThreadId ? (
                    <MailboxAction label="Conversation" onPress={() => showConversation(peerId)} />
                  ) : null}
                  {outgoing ? (
                    <MailboxAction
                      label="Sending turn"
                      onPress={() => {
                        setBeforeTurn(undefined);
                        setExecutionId(message.executionId);
                        setHistoryOpen(true);
                      }}
                    />
                  ) : null}
                  {!outgoing && message.state === "dismissed" ? (
                    <MailboxAction
                      label="Restore"
                      disabled={busy}
                      onPress={() =>
                        void mutate({ kind: "state", messageId: message.id, state: "queued" })
                      }
                    />
                  ) : null}
                  {incomingOpen ? (
                    <MailboxAction
                      label="Dismiss"
                      disabled={busy}
                      onPress={() =>
                        void mutate({ kind: "state", messageId: message.id, state: "dismissed" })
                      }
                    />
                  ) : null}
                </View>
              </View>
            );
          })}
          {!messageId && (before || query.data?.nextCursor) ? (
            <View className="flex-row flex-wrap gap-2">
              {before ? (
                <MailboxAction label="Latest messages" onPress={() => setBefore(undefined)} />
              ) : null}
              {query.data?.nextCursor ? (
                <MailboxAction
                  label="Older messages"
                  onPress={() => setBefore(query.data!.nextCursor!)}
                />
              ) : null}
            </View>
          ) : null}
        </View>
        {turns.length > 0 || executionId || beforeTurn ? (
          <View className="gap-3">
            <View className="flex-row flex-wrap items-center justify-between gap-2">
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: historyOpen }}
                onPress={() => setHistoryOpen((value) => !value)}
                className="min-h-11 justify-center"
              >
                <Text className="font-t3-bold">
                  {historyOpen ? "▾" : "▸"} Turn history ({turns.length})
                </Text>
              </Pressable>
              {executionId || beforeTurn ? (
                <MailboxAction
                  label="Recent turns"
                  onPress={() => {
                    setExecutionId(undefined);
                    setBeforeTurn(undefined);
                  }}
                />
              ) : null}
            </View>
            {historyOpen ? (
              <>
                <Text className="text-sm text-foreground-muted">
                  What each of this thread’s turns received, read, and sent.
                </Text>
                {turns.map((turn) => {
                  const groups = (
                    [
                      ["Received", turn.incoming],
                      ["Read", turn.read],
                      ["Sent", turn.sent],
                    ] as const
                  ).filter(([, ids]) => ids.length > 0);
                  return (
                    <View
                      key={turn.executionId}
                      className="gap-2 rounded-lg border border-border bg-card p-3"
                    >
                      <Text className="text-xs text-foreground-muted">
                        {formatMailboxTime(turn.createdAt)}
                      </Text>
                      <View className="flex-row flex-wrap gap-2">
                        <StatusBadge status={mailboxTurnStatus[turn.state]} />
                        {turn.source === "mailbox" ? (
                          <StatusBadge status={{ label: "Woken by mail", tone: "info" }} />
                        ) : null}
                      </View>
                      {groups.length === 0 ? (
                        <Text className="text-sm text-foreground-muted">No mail</Text>
                      ) : null}
                      {groups.map(([label, ids]) => (
                        <View key={label} className="gap-1">
                          <Text className="text-sm text-foreground-muted">
                            {label} ({ids.length})
                          </Text>
                          <View className="flex-row flex-wrap">
                            {ids.map((id, index) => (
                              <MailboxAction
                                key={id}
                                label={`Message ${index + 1}`}
                                onPress={() => showMessage(id)}
                              />
                            ))}
                          </View>
                        </View>
                      ))}
                    </View>
                  );
                })}
                {!executionId && query.data?.nextTurnCursor ? (
                  <MailboxAction
                    label="Older turns"
                    onPress={() => setBeforeTurn(query.data!.nextTurnCursor!)}
                  />
                ) : null}
              </>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </ThemedSafeAreaView>
  );
}
