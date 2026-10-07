import { getMailboxThreadCandidates } from "@t3tools/client-runtime/state/mailbox-candidates";
import { formatMailboxConversationExport } from "@t3tools/client-runtime/state/mailbox-export";
import {
  formatMailboxTime,
  getMailboxConversationMessages,
  getMailboxThreadStatus,
  mailboxMessageStatus,
  mailboxTurnStatus,
  type MailboxStatus,
} from "@t3tools/client-runtime/state/mailbox-presentation";
import { onOpenAgentMailbox } from "~/mailboxBus";
import { cn, randomUUID } from "~/lib/utils";
import {
  CommandId,
  type EnvironmentId,
  type MailboxGetInput,
  type MailboxUpdateInput,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  Link2Icon,
  MailIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useProjects, useThreadShell, useThreadShells } from "~/state/entities";
import { mailboxEnvironment } from "~/state/mailbox";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

function StatusBadge({ status }: { status: MailboxStatus }) {
  return (
    <Badge variant={status.tone === "neutral" ? "secondary" : status.tone} size="sm">
      {status.label}
    </Badge>
  );
}

function SectionHeading({
  title,
  count,
  children,
}: {
  title: string;
  count?: number | undefined;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {title}
        {count !== undefined ? (
          <Badge variant="secondary" size="sm">
            {count}
          </Badge>
        ) : null}
      </h3>
      {children}
    </div>
  );
}

export function AgentMailbox({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const [open, setOpen] = useState(false);
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const shell = useThreadShell(scopeThreadRef(environmentId, threadId));
  const threads = useThreadShells();
  const projects = useProjects();
  const query = useEnvironmentQuery(
    open
      ? mailboxEnvironment.detail({
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
        })
      : null,
  );
  const update = useAtomCommand(mailboxEnvironment.update);
  const exportConversation = useAtomCommand(mailboxEnvironment.exportConversation);
  const revision = shell?.mailboxRevision;
  const refresh = query.refresh;
  useEffect(() => {
    if (open && revision !== undefined) refresh();
  }, [open, revision, refresh]);
  useEffect(
    () =>
      onOpenAgentMailbox((ref) => {
        if (ref.environmentId === environmentId && ref.threadId === threadId) setOpen(true);
      }),
    [environmentId, threadId],
  );
  const threadById = useMemo(
    () =>
      new Map(
        (open ? threads : [])
          .filter((entry) => entry.environmentId === environmentId)
          .map((entry) => [entry.id, entry]),
      ),
    [threads, environmentId, open],
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
  const mutate = async (operation: MailboxUpdateInput["operation"]) => {
    setBusy(true);
    try {
      const result = await update({
        environmentId,
        input: { threadId, commandId: CommandId.make(randomUUID()), operation },
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
  const linkedThreadIds = query.data?.peers;
  const peers = linkedThreadIds ?? [];
  const candidates = useMemo(
    () =>
      !open || linkedThreadIds === undefined
        ? []
        : getMailboxThreadCandidates({
            threads,
            projects,
            environmentId,
            threadId,
            linkedThreadIds,
            search,
          }),
    [open, threads, projects, environmentId, threadId, linkedThreadIds, search],
  );
  const visibleCandidates = candidates.slice(0, candidateLimit);
  // First-time users have nothing linked, so the picker starts open for them.
  const showPicker = pickerOpen || (linkedThreadIds !== undefined && peers.length === 0);
  const pendingCount =
    query.data?.pendingCount ?? (peerThreadId ? 0 : shell?.mailboxPendingCount) ?? 0;
  const autoWake = query.data?.autoWake;
  const messages = useMemo(
    () =>
      peerThreadId
        ? getMailboxConversationMessages(query.data?.messages ?? [], threadId, peerThreadId)
        : (query.data?.messages ?? []),
    [query.data?.messages, threadId, peerThreadId],
  );
  const turns = query.data?.turns ?? [];

  const threadName = (id: ThreadId) => {
    const thread = threadById.get(id);
    if (!thread) return { project: null, title: "Unavailable thread" };
    return {
      project: projectById.get(thread.projectId)?.title ?? "Project",
      title: thread.title,
    };
  };
  const threadLink = (id: ThreadId, className?: string) => {
    const { title } = threadName(id);
    return threadById.has(id) ? (
      <Link
        className={cn("truncate font-medium hover:underline", className)}
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(scopeThreadRef(environmentId, id))}
        onClick={() => setOpen(false)}
      >
        {title}
      </Link>
    ) : (
      <span className={cn("truncate text-muted-foreground", className)}>{title}</span>
    );
  };
  const showMessage = (id: string) => {
    setMessageSearch("");
    setAppliedSearch("");
    setBefore(undefined);
    setPeerThreadId(undefined);
    setMessageId(id);
  };
  const showConversation = (id: ThreadId | undefined) => {
    setMessageSearch("");
    setAppliedSearch("");
    setBefore(undefined);
    setMessageId(undefined);
    setPeerThreadId(id);
  };
  const applyMessageSearch = (value = messageSearch) => {
    setBefore(undefined);
    setMessageSearch(value);
    setAppliedSearch(value.trim());
  };
  const downloadConversation = async () => {
    if (!peerThreadId || exporting) return;
    setExporting(true);
    setMutationError(null);
    try {
      const result = await exportConversation({ environmentId, input: { threadId, peerThreadId } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const { filename, contents } = formatMailboxConversationExport({
        participants: [
          { threadId, ...threadName(threadId) },
          { threadId: peerThreadId, ...threadName(peerThreadId) },
        ],
        messages: result.value,
        exportedAt: new Date().toISOString(),
      });
      const url = URL.createObjectURL(
        new Blob([contents], { type: "application/json;charset=utf-8" }),
      );
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (error) {
      setMutationError(
        error instanceof Error ? error.message : "Could not export the conversation. Try again.",
      );
    } finally {
      setExporting(false);
    }
  };

  if (revision === undefined) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Agent mailbox${shell?.mailboxPendingCount ? `, ${shell.mailboxPendingCount} pending` : ""}`}
        title="Agent mailbox"
        onClick={() => setOpen(true)}
      >
        <MailIcon className="size-4" />
        {shell?.mailboxPendingCount ? <span>{shell.mailboxPendingCount}</span> : null}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <DialogTitle>{peerThreadId ? "Conversation" : "Agent mailbox"}</DialogTitle>
                <DialogDescription>
                  {peerThreadId
                    ? `${threadName(threadId).title} ↔ ${threadName(peerThreadId).title}`
                    : "Linked threads can message each other. A message wakes an idle agent; a busy agent sees it once its turn ends."}
                </DialogDescription>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Refresh mailbox"
                title="Refresh"
                className="shrink-0"
                onClick={refresh}
                disabled={query.isPending}
              >
                <RefreshCwIcon className={cn("size-4", query.isPending && "animate-spin")} />
              </Button>
            </div>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-6">
              {mutationError || query.error ? (
                <p
                  role="alert"
                  className="rounded-md bg-destructive/8 p-3 text-sm text-destructive"
                >
                  {mutationError ?? query.error}
                </p>
              ) : null}

              {!peerThreadId ? (
                <section className="space-y-2">
                  <SectionHeading title="Linked threads" count={peers.length}>
                    {peers.length > 0 ? (
                      <Button
                        size="sm"
                        variant={pickerOpen ? "ghost" : "outline"}
                        onClick={() => setPickerOpen((value) => !value)}
                      >
                        {pickerOpen ? (
                          <XIcon className="size-3.5" />
                        ) : (
                          <PlusIcon className="size-3.5" />
                        )}
                        {pickerOpen ? "Done" : "Link a thread"}
                      </Button>
                    ) : null}
                  </SectionHeading>
                  {peers.length > 0 ? (
                    <ul className="divide-y rounded-lg border">
                      {peers.map((id) => {
                        const { project } = threadName(id);
                        return (
                          <li key={id} className="flex items-center gap-3 px-3 py-2 text-sm">
                            <Link2Icon className="size-4 shrink-0 text-muted-foreground" />
                            <div className="flex min-w-0 flex-1 flex-col">
                              {threadLink(id)}
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                {project ? (
                                  <span className="truncate text-xs text-muted-foreground">
                                    {project}
                                  </span>
                                ) : null}
                                <StatusBadge status={getMailboxThreadStatus(threadById.get(id))} />
                              </div>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`View conversation with ${threadName(id).title}`}
                              onClick={() => showConversation(id)}
                            >
                              Conversation
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost-muted"
                              disabled={busy}
                              onClick={() =>
                                void mutate({ kind: "link", peerThreadId: id, linked: false })
                              }
                            >
                              Unlink
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : linkedThreadIds !== undefined ? (
                    <p className="text-sm text-muted-foreground">
                      Nothing linked yet. Pick a thread below so the two agents can message each
                      other.
                    </p>
                  ) : null}
                  {showPicker ? (
                    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                      <Input
                        aria-label="Find a thread to link"
                        placeholder="Search unsettled threads in this environment…"
                        value={search}
                        autoFocus={peers.length > 0}
                        onChange={(event) => {
                          setSearch(event.target.value);
                          setCandidateLimit(8);
                        }}
                      />
                      {visibleCandidates.length > 0 ? (
                        <ul className="divide-y rounded-md border bg-background">
                          {visibleCandidates.map((thread) => (
                            <li
                              key={thread.id}
                              className="flex items-center gap-3 px-3 py-2 text-sm"
                            >
                              <div className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate">{thread.title}</span>
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                                  <span className="truncate">
                                    {projectById.get(thread.projectId)?.title ?? "Project"}
                                  </span>
                                  <StatusBadge status={getMailboxThreadStatus(thread)} />
                                </div>
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                aria-label={`Link ${thread.title}`}
                                disabled={busy}
                                onClick={() =>
                                  void mutate({
                                    kind: "link",
                                    peerThreadId: thread.id,
                                    linked: true,
                                  })
                                }
                              >
                                Link
                              </Button>
                            </li>
                          ))}
                        </ul>
                      ) : linkedThreadIds !== undefined ? (
                        <p className="px-1 py-2 text-sm text-muted-foreground">
                          {search.trim()
                            ? "No matching unsettled threads in this environment."
                            : "No other unsettled threads in this environment to link."}
                        </p>
                      ) : null}
                      {candidates.length > candidateLimit ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="w-full"
                          onClick={() => setCandidateLimit((limit) => limit + 8)}
                        >
                          Show {candidates.length - candidateLimit} more
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              ) : null}

              {autoWake && !peerThreadId ? (
                <section className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
                  <div className="min-w-0 space-y-0.5 text-sm">
                    <label htmlFor="mailbox-auto-wake" className="font-medium">
                      Wake this agent on new mail
                    </label>
                    <p className="text-xs text-muted-foreground">
                      {autoWake.enabled
                        ? "A message starts a turn when this thread is idle."
                        : (autoWake.reason ?? "Messages queue until you send the next turn.")}
                    </p>
                  </div>
                  <Switch
                    id="mailbox-auto-wake"
                    checked={autoWake.enabled}
                    disabled={busy}
                    onCheckedChange={(enabled) => void mutate({ kind: "auto-wake", enabled })}
                  />
                </section>
              ) : null}

              <section className="space-y-2">
                <SectionHeading
                  title={peerThreadId ? "Message history" : "Messages"}
                  count={query.data && !messageId ? messages.length : undefined}
                >
                  <div className="flex items-center gap-2">
                    {pendingCount > 0 ? (
                      <Badge variant="warning" size="sm">
                        {pendingCount} waiting
                      </Badge>
                    ) : null}
                    {messageId || peerThreadId ? (
                      <Button size="sm" variant="ghost" onClick={() => showConversation(undefined)}>
                        All messages
                      </Button>
                    ) : null}
                  </div>
                </SectionHeading>
                {peerThreadId ? (
                  <div className="space-y-2">
                    <form
                      className="flex flex-wrap items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        applyMessageSearch();
                      }}
                    >
                      <div className="min-w-40 flex-1">
                        <Input
                          aria-label="Search conversation messages"
                          placeholder="Search messages…"
                          value={messageSearch}
                          maxLength={500}
                          onChange={(event) => setMessageSearch(event.target.value)}
                        />
                      </div>
                      <Button type="submit" size="sm" variant="outline">
                        Search
                      </Button>
                      {appliedSearch || messageSearch ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => applyMessageSearch("")}
                        >
                          Clear
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={exporting}
                        onClick={() => void downloadConversation()}
                      >
                        {exporting ? "Exporting…" : "Export JSON"}
                      </Button>
                    </form>
                    {appliedSearch ? (
                      <p className="text-xs text-muted-foreground">
                        Results for “{appliedSearch}” across this conversation.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {peerThreadId ? (
                  <p className="text-xs text-muted-foreground">
                    {appliedSearch
                      ? "Matching messages, oldest first."
                      : before
                        ? "Older messages, oldest first."
                        : "Latest messages, oldest first."}{" "}
                    Opening this history does not mark messages as read by the agent.
                  </p>
                ) : null}
                {query.isPending && !query.data ? (
                  <p className="text-sm text-muted-foreground">Loading mailbox…</p>
                ) : null}
                {query.data && messages.length === 0 ? (
                  <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                    {appliedSearch
                      ? "No messages match your search."
                      : peerThreadId
                        ? "No messages between these threads yet."
                        : peers.length === 0
                          ? "Link a thread to start exchanging messages."
                          : "No messages between this thread and its links yet."}
                  </p>
                ) : null}
                {messages.length > 0 ? (
                  <ul className="space-y-2">
                    {messages.map((message) => {
                      const outgoing = message.fromThreadId === threadId;
                      const peerId = outgoing ? message.toThreadId : message.fromThreadId;
                      const incomingOpen =
                        !outgoing && message.state !== "resolved" && message.state !== "dismissed";
                      return (
                        <li
                          key={message.id}
                          className={cn(
                            "space-y-2 rounded-lg border p-3 text-sm",
                            peerThreadId && (outgoing ? "ml-8 bg-primary/5" : "mr-8 bg-muted/30"),
                          )}
                        >
                          <div className="flex items-center gap-2">
                            {outgoing ? (
                              <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <ArrowDownLeftIcon className="size-4 shrink-0 text-primary" />
                            )}
                            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                              <span className="shrink-0 text-muted-foreground">
                                {peerThreadId ? "From" : outgoing ? "To" : "From"}
                              </span>
                              {threadLink(peerThreadId ? message.fromThreadId : peerId)}
                            </span>
                            <StatusBadge status={mailboxMessageStatus[message.state]} />
                          </div>
                          {message.replyTo ? (
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={() => showMessage(message.replyTo!)}
                            >
                              View replied-to message
                            </Button>
                          ) : null}
                          <p className="whitespace-pre-wrap break-words">{message.body}</p>
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                            <div>
                              <time dateTime={message.createdAt}>
                                {formatMailboxTime(message.createdAt)}
                              </time>
                              {message.updatedAt !== message.createdAt ? (
                                <p>State updated {formatMailboxTime(message.updatedAt)}</p>
                              ) : null}
                            </div>
                            <div className="flex flex-wrap items-center gap-1">
                              {!peerThreadId ? (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => showConversation(peerId)}
                                >
                                  Conversation
                                </Button>
                              ) : null}
                              {outgoing ? (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => {
                                    setBeforeTurn(undefined);
                                    setExecutionId(message.executionId);
                                    setHistoryOpen(true);
                                  }}
                                >
                                  Sending turn
                                </Button>
                              ) : null}
                              {!outgoing && message.state === "dismissed" ? (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() =>
                                    void mutate({
                                      kind: "state",
                                      messageId: message.id,
                                      state: "queued",
                                    })
                                  }
                                >
                                  Restore
                                </Button>
                              ) : null}
                              {incomingOpen ? (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  disabled={busy}
                                  onClick={() =>
                                    void mutate({
                                      kind: "state",
                                      messageId: message.id,
                                      state: "dismissed",
                                    })
                                  }
                                >
                                  Dismiss
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                {(before && !messageId) || (query.data?.nextCursor && !messageId) ? (
                  <div className="flex gap-2">
                    {before ? (
                      <Button size="sm" variant="ghost" onClick={() => setBefore(undefined)}>
                        Latest
                      </Button>
                    ) : null}
                    {query.data?.nextCursor ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setBefore(query.data!.nextCursor!)}
                      >
                        Older messages
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </section>

              {turns.length > 0 || executionId || beforeTurn ? (
                <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
                  <section className="space-y-2">
                    <div className="flex min-h-7 items-center justify-between gap-3">
                      <CollapsibleTrigger className="group flex items-center gap-1.5 text-sm font-medium">
                        <ChevronRightIcon className="size-4 text-muted-foreground transition-transform duration-200 group-data-panel-open:rotate-90" />
                        Turn history
                        <Badge variant="secondary" size="sm">
                          {turns.length}
                        </Badge>
                      </CollapsibleTrigger>
                      {executionId || beforeTurn ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setExecutionId(undefined);
                            setBeforeTurn(undefined);
                          }}
                        >
                          Recent turns
                        </Button>
                      ) : null}
                    </div>
                    <CollapsiblePanel>
                      <p className="pb-2 text-xs text-muted-foreground">
                        What each of this thread's turns received, read, and sent.
                      </p>
                      <ul className="divide-y rounded-lg border text-xs">
                        {turns.map((turn) => {
                          const groups = (
                            [
                              ["Received", turn.incoming],
                              ["Read", turn.read],
                              ["Sent", turn.sent],
                            ] as const
                          ).filter(([, ids]) => ids.length > 0);
                          return (
                            <li key={turn.executionId} className="space-y-1.5 px-3 py-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <time dateTime={turn.createdAt} className="text-muted-foreground">
                                  {formatMailboxTime(turn.createdAt)}
                                </time>
                                <StatusBadge status={mailboxTurnStatus[turn.state]} />
                                {turn.source === "mailbox" ? (
                                  <Badge variant="info" size="sm">
                                    Woken by mail
                                  </Badge>
                                ) : null}
                                {groups.length === 0 ? (
                                  <span className="text-muted-foreground">No mail</span>
                                ) : null}
                              </div>
                              {groups.map(([label, ids]) => (
                                <div
                                  key={label}
                                  className="flex flex-wrap items-center gap-x-2 gap-y-1"
                                >
                                  <span className="text-muted-foreground">{label}</span>
                                  {ids.map((id, index) => (
                                    <button
                                      key={id}
                                      className="text-primary hover:underline"
                                      onClick={() => showMessage(id)}
                                    >
                                      Message {index + 1}
                                    </button>
                                  ))}
                                </div>
                              ))}
                            </li>
                          );
                        })}
                      </ul>
                      {query.data?.nextTurnCursor ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-2"
                          onClick={() => {
                            setExecutionId(undefined);
                            setBeforeTurn(query.data!.nextTurnCursor!);
                          }}
                        >
                          Older turns
                        </Button>
                      ) : null}
                    </CollapsiblePanel>
                  </section>
                </Collapsible>
              ) : null}
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
