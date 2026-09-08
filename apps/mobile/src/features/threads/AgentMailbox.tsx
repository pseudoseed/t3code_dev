import { getMailboxThreadCandidates } from "@t3tools/client-runtime/state/mailbox-candidates";
import {
  CommandId,
  type EnvironmentId,
  type MailboxGetInput,
  type MailboxUpdateInput,
  type ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CommonActions, useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import { AppText as Text } from "../../components/AppText";
import { useProjects, useThreadShells } from "../../state/entities";
import { mailboxEnvironment } from "../../state/mailbox";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

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
      onRequestClose={props.close}
    >
      {props.open ? <MailboxContents {...props} /> : null}
    </Modal>
  );
}

function MailboxContents({
  environmentId,
  threadId,
  revision,
  close,
}: MailboxProps & { close: () => void }) {
  const [search, setSearch] = useState("");
  const [candidateLimit, setCandidateLimit] = useState(12);
  const [before, setBefore] = useState<MailboxGetInput["before"]>();
  const [beforeTurn, setBeforeTurn] = useState<MailboxGetInput["beforeTurn"]>();
  const [messageId, setMessageId] = useState<MailboxGetInput["messageId"]>();
  const [expandedTurn, setExpandedTurn] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const threads = useThreadShells();
  const projects = useProjects();
  const navigation = useNavigation();
  const query = useEnvironmentQuery(
    mailboxEnvironment.detail({
      environmentId,
      input: {
        threadId,
        ...(before ? { before } : {}),
        ...(beforeTurn ? { beforeTurn } : {}),
        ...(messageId ? { messageId } : {}),
      },
    }),
  );
  const update = useAtomCommand(mailboxEnvironment.update);
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
  const name = (id: ThreadId) => {
    const thread = threadById.get(id);
    return thread
      ? `${projectById.get(thread.projectId)?.title ?? "Project"} / ${thread.title}`
      : "Unavailable thread";
  };
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
    if (!threads.some((entry) => entry.environmentId === environmentId && entry.id === id)) return;
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
  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-row items-center justify-between px-4 py-3">
        <Text className="text-lg font-semibold">Agent mailbox</Text>
        <Pressable accessibilityRole="button" onPress={close} className="p-2">
          <Text className="text-primary">Done</Text>
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 20 }}
        keyboardShouldPersistTaps="handled"
      >
        <Text className="text-sm text-muted-foreground">
          Messages wake idle agents automatically. If an agent is working, messages wait until its
          turn finishes or it checks its inbox.
        </Text>
        {mutationError || query.error ? (
          <Text accessibilityRole="alert" className="text-destructive">
            {mutationError ?? query.error}
          </Text>
        ) : null}
        <View className="flex-row items-center justify-between">
          <Text>{query.data?.pendingCount ?? 0} pending</Text>
          <Pressable accessibilityRole="button" onPress={refresh} className="p-2">
            <Text className="text-primary">Refresh</Text>
          </Pressable>
        </View>
        {query.data?.autoWake ? (
          <View className="gap-2 rounded-lg border border-border p-3">
            <Text>Automatic wake {query.data.autoWake.enabled ? "on" : "paused"}</Text>
            {query.data.autoWake.reason ? (
              <Text className="text-sm text-muted-foreground">{query.data.autoWake.reason}</Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              className="py-2"
              onPress={() =>
                void mutate({ kind: "auto-wake", enabled: !query.data!.autoWake!.enabled })
              }
            >
              <Text className="text-primary">
                {query.data.autoWake.enabled ? "Pause automatic wake" : "Resume automatic wake"}
              </Text>
            </Pressable>
          </View>
        ) : null}
        <View className="gap-2">
          <Text className="font-semibold">Collaborating threads</Text>
          {peers.map((id) => (
            <View key={id} className="flex-row items-center justify-between gap-2">
              <Pressable
                accessibilityRole="link"
                className="flex-1 py-2"
                onPress={() => openThread(id)}
              >
                <Text className="text-primary">{name(id)}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => void mutate({ kind: "link", peerThreadId: id, linked: false })}
                className="p-2"
              >
                <Text>Unlink</Text>
              </Pressable>
            </View>
          ))}
          {peers.length === 0 ? (
            <Text className="text-sm text-muted-foreground">
              Link a thread in this environment to let the agents exchange messages.
            </Text>
          ) : null}
          <TextInput
            accessibilityLabel="Find a collaborating thread"
            placeholder="Find a project or thread…"
            value={search}
            onChangeText={(value) => {
              setSearch(value);
              setCandidateLimit(12);
            }}
            className="rounded-lg border border-border p-3 text-foreground"
          />
          <Text className="text-sm text-muted-foreground">
            Available threads ({candidates.length}). Search also includes settled threads in this
            environment.
          </Text>
          {visibleCandidates.map((thread) => (
            <View key={thread.id} className="flex-row items-center justify-between gap-2">
              <View className="flex-1">
                <Text>{thread.title}</Text>
                <Text className="text-sm text-muted-foreground">
                  {projectById.get(thread.projectId)?.title ?? "Project"}
                  {thread.settledOverride === "settled" ? " · Settled" : ""}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Link ${thread.title}`}
                disabled={busy}
                onPress={() => void mutate({ kind: "link", peerThreadId: thread.id, linked: true })}
                className="p-3"
              >
                <Text className="text-primary">Link</Text>
              </Pressable>
            </View>
          ))}
          {linkedThreadIds !== undefined && candidates.length === 0 ? (
            <Text className="text-sm text-muted-foreground">
              {search.trim()
                ? "No matching threads in this environment."
                : "No other active threads available to link."}
            </Text>
          ) : null}
          {candidates.length > candidateLimit ? (
            <Pressable
              accessibilityRole="button"
              className="py-2"
              onPress={() => setCandidateLimit((limit) => limit + 12)}
            >
              <Text className="text-primary">
                Show more threads ({candidates.length - candidateLimit} remaining)
              </Text>
            </Pressable>
          ) : null}
        </View>
        <View className="gap-3">
          <View className="flex-row justify-between">
            <Text className="font-semibold">Messages</Text>
            {messageId ? (
              <Pressable accessibilityRole="button" onPress={() => setMessageId(undefined)}>
                <Text className="text-primary">All messages</Text>
              </Pressable>
            ) : null}
          </View>
          {query.isPending && !query.data ? <Text>Loading mailbox…</Text> : null}
          {query.data?.messages.length === 0 ? (
            <Text className="text-muted-foreground">No messages yet.</Text>
          ) : null}
          {query.data?.messages.map((message) => (
            <View key={message.id} className="gap-2 rounded-lg border border-border p-3">
              <Pressable
                accessibilityRole="link"
                onPress={() =>
                  openThread(
                    message.fromThreadId === threadId ? message.toThreadId : message.fromThreadId,
                  )
                }
              >
                <Text className="text-primary">
                  {message.fromThreadId === threadId
                    ? `To ${name(message.toThreadId)}`
                    : `From ${name(message.fromThreadId)}`}
                </Text>
              </Pressable>
              <Text className="text-xs text-muted-foreground">
                {message.state} · {new Date(message.createdAt).toLocaleString()}
              </Text>
              <Text selectable>{message.body}</Text>
              {message.toThreadId === threadId && message.state === "dismissed" ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() =>
                    void mutate({ kind: "state", messageId: message.id, state: "queued" })
                  }
                  className="self-start py-2"
                >
                  <Text className="text-primary">Restore</Text>
                </Pressable>
              ) : null}
              {message.toThreadId === threadId &&
              message.state !== "resolved" &&
              message.state !== "dismissed" ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() =>
                    void mutate({ kind: "state", messageId: message.id, state: "dismissed" })
                  }
                  className="self-start py-2"
                >
                  <Text className="text-muted-foreground">Dismiss</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
          <View className="flex-row gap-4">
            {before && !messageId ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setBefore(undefined)}
                className="py-2"
              >
                <Text className="text-primary">Latest messages</Text>
              </Pressable>
            ) : null}
            {query.data?.nextCursor && !messageId ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => setBefore(query.data!.nextCursor!)}
                className="py-2"
              >
                <Text className="text-primary">Older messages</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
        <View className="gap-2">
          <View className="flex-row justify-between">
            <Text className="font-semibold">Turn communication</Text>
            {beforeTurn ? (
              <Pressable accessibilityRole="button" onPress={() => setBeforeTurn(undefined)}>
                <Text className="text-primary">Recent turns</Text>
              </Pressable>
            ) : null}
          </View>
          {query.data?.turns.map((turn) => (
            <View key={turn.executionId} className="gap-1 rounded-lg border border-border p-3">
              <Text className="text-sm">
                {new Date(turn.createdAt).toLocaleString()} · {turn.state}
                {turn.source === "mailbox" ? " · automatic wake" : ""}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {turn.incoming.length} incoming · {turn.read.length} read · {turn.sent.length} sent
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  setExpandedTurn(expandedTurn === turn.executionId ? null : turn.executionId)
                }
                className="py-2"
              >
                <Text className="text-primary">
                  {expandedTurn === turn.executionId ? "Hide messages" : "View messages"}
                </Text>
              </Pressable>
              {expandedTurn === turn.executionId
                ? (
                    [
                      ["Incoming", turn.incoming],
                      ["Read", turn.read],
                      ["Sent", turn.sent],
                    ] as const
                  ).map(([label, ids]) => (
                    <View key={label} className="gap-1">
                      <Text className="text-sm">
                        {label}: {ids.length === 0 ? "None" : ""}
                      </Text>
                      {ids.map((id, index) => (
                        <Pressable
                          key={id}
                          accessibilityRole="button"
                          onPress={() => {
                            setBefore(undefined);
                            setMessageId(id);
                          }}
                          className="py-2"
                        >
                          <Text className="text-primary">Message {index + 1}</Text>
                        </Pressable>
                      ))}
                    </View>
                  ))
                : null}
            </View>
          ))}
          {query.data?.nextTurnCursor ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setBeforeTurn(query.data!.nextTurnCursor!)}
              className="py-2"
            >
              <Text className="text-primary">Older turns</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
