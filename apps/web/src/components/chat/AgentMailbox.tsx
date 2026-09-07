import { onOpenAgentMailbox } from "~/mailboxBus";
import { randomUUID } from "~/lib/utils";
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
import { MailIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useProjects, useThreadShell, useThreadShells } from "~/state/entities";
import { mailboxEnvironment } from "~/state/mailbox";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogHeader,
} from "../ui/dialog";

export function AgentMailbox({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [before, setBefore] = useState<MailboxGetInput["before"]>();
  const [executionId, setExecutionId] = useState<MailboxGetInput["executionId"]>();
  const [beforeTurn, setBeforeTurn] = useState<MailboxGetInput["beforeTurn"]>();
  const [messageId, setMessageId] = useState<MailboxGetInput["messageId"]>();
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
          },
        })
      : null,
  );
  const update = useAtomCommand(mailboxEnvironment.update);
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
  const peers = (query.data?.peers ?? []).filter((id) =>
    threads.some((entry) => entry.environmentId === environmentId && entry.id === id),
  );
  const candidates = !search.trim()
    ? []
    : threads
        .filter(
          (entry) =>
            entry.environmentId === environmentId &&
            entry.id !== threadId &&
            !entry.archivedAt &&
            !peers.includes(entry.id) &&
            name(entry.id).toLowerCase().includes(search.toLowerCase()),
        )
        .slice(0, 12);
  const threadLink = (id: ThreadId) =>
    !threads.some((entry) => entry.environmentId === environmentId && entry.id === id) ? (
      <span>{name(id)}</span>
    ) : (
      <Link
        className="text-primary hover:underline"
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(scopeThreadRef(environmentId, id))}
        onClick={() => setOpen(false)}
      >
        {name(id)}
      </Link>
    );
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
            <DialogTitle>Agent mailbox</DialogTitle>
            <DialogDescription>
              Messages wake idle agents automatically. If an agent is working, messages wait until
              its turn finishes or it checks its inbox.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-5">
            {mutationError || query.error ? (
              <p role="alert" className="text-destructive">
                {mutationError ?? query.error}
              </p>
            ) : null}
            <div className="flex items-center justify-between text-sm">
              <span>{query.data?.pendingCount ?? shell?.mailboxPendingCount ?? 0} pending</span>
              <Button size="sm" variant="ghost" onClick={refresh} disabled={query.isPending}>
                Refresh
              </Button>
            </div>
            {query.data?.autoWake ? (
              <section className="space-y-2 rounded-lg border p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span>Automatic wake {query.data.autoWake.enabled ? "on" : "paused"}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void mutate({ kind: "auto-wake", enabled: !query.data!.autoWake!.enabled })
                    }
                  >
                    {query.data.autoWake.enabled ? "Pause automatic wake" : "Resume automatic wake"}
                  </Button>
                </div>
                {query.data.autoWake.reason ? (
                  <p className="text-muted-foreground">{query.data.autoWake.reason}</p>
                ) : null}
              </section>
            ) : null}
            <section className="space-y-2">
              <h3 className="text-sm font-medium">Collaborating threads</h3>
              {peers.map((id) => (
                <div key={id} className="flex items-center justify-between gap-2 text-sm">
                  {threadLink(id)}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void mutate({ kind: "link", peerThreadId: id, linked: false })}
                  >
                    Unlink
                  </Button>
                </div>
              ))}
              {peers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Link a thread in this environment to let the agents exchange messages.
                </p>
              ) : null}
              <Input
                aria-label="Find a collaborating thread"
                placeholder="Find a project or thread…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search.trim()
                ? candidates.map((thread) => (
                    <div
                      key={thread.id}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <span className="truncate">{name(thread.id)}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void mutate({ kind: "link", peerThreadId: thread.id, linked: true })
                        }
                      >
                        Link
                      </Button>
                    </div>
                  ))
                : null}
            </section>
            <section className="space-y-3">
              <div className="flex justify-between">
                <h3 className="text-sm font-medium">Messages</h3>
                {messageId ? (
                  <button className="text-xs text-primary" onClick={() => setMessageId(undefined)}>
                    All messages
                  </button>
                ) : null}
              </div>
              {query.isPending && !query.data ? (
                <p className="text-sm text-muted-foreground">Loading mailbox…</p>
              ) : null}
              {query.data?.messages.length === 0 ? (
                <p className="text-sm text-muted-foreground">No messages yet.</p>
              ) : null}
              {query.data?.messages.map((message) => (
                <article key={message.id} className="space-y-2 rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {message.fromThreadId === threadId ? (
                        <>To {threadLink(message.toThreadId)}</>
                      ) : (
                        <>From {threadLink(message.fromThreadId)}</>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">{message.state}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words">{message.body}</p>
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <time>{new Date(message.createdAt).toLocaleString()}</time>
                    {message.fromThreadId === threadId ? (
                      <button
                        className="hover:underline"
                        onClick={() => {
                          setBeforeTurn(undefined);
                          setExecutionId(message.executionId);
                        }}
                      >
                        View sending turn
                      </button>
                    ) : null}
                  </div>
                  {message.toThreadId === threadId && message.state === "dismissed" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void mutate({ kind: "state", messageId: message.id, state: "queued" })
                      }
                    >
                      Restore
                    </Button>
                  ) : null}
                  {message.toThreadId === threadId &&
                  message.state !== "resolved" &&
                  message.state !== "dismissed" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void mutate({ kind: "state", messageId: message.id, state: "dismissed" })
                      }
                    >
                      Dismiss
                    </Button>
                  ) : null}
                </article>
              ))}
              <div className="flex gap-2">
                {before && !messageId ? (
                  <Button size="sm" variant="ghost" onClick={() => setBefore(undefined)}>
                    Latest messages
                  </Button>
                ) : null}
                {query.data?.nextCursor && !messageId ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setBefore(query.data!.nextCursor!)}
                  >
                    Older messages
                  </Button>
                ) : null}
              </div>
            </section>
            <section className="space-y-2">
              <div className="flex justify-between">
                <h3 className="text-sm font-medium">Turn communication</h3>
                {executionId || beforeTurn ? (
                  <button
                    className="text-xs text-primary"
                    onClick={() => {
                      setExecutionId(undefined);
                      setBeforeTurn(undefined);
                    }}
                  >
                    Recent turns
                  </button>
                ) : null}
              </div>
              {query.data?.turns.map((turn) => (
                <details key={turn.executionId} className="rounded-md border p-2 text-xs">
                  <summary className="cursor-pointer">
                    {new Date(turn.createdAt).toLocaleString()} · {turn.incoming.length} incoming ·{" "}
                    {turn.read.length} read · {turn.sent.length} sent · {turn.state}
                    {turn.source === "mailbox" ? " · automatic wake" : ""}
                  </summary>
                  {(
                    [
                      ["Incoming", turn.incoming],
                      ["Read", turn.read],
                      ["Sent", turn.sent],
                    ] as const
                  ).map(([label, ids]) => (
                    <div key={label} className="mt-2 flex flex-wrap gap-2">
                      <span>{label}:</span>
                      {ids.length === 0
                        ? "None"
                        : ids.map((id, index) => (
                            <button
                              key={id}
                              className="text-primary hover:underline"
                              onClick={() => {
                                setBefore(undefined);
                                setMessageId(id);
                              }}
                            >
                              Message {index + 1}
                            </button>
                          ))}
                    </div>
                  ))}
                </details>
              ))}
              {query.data?.nextTurnCursor ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setExecutionId(undefined);
                    setBeforeTurn(query.data!.nextTurnCursor!);
                  }}
                >
                  Older turns
                </Button>
              ) : null}
            </section>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
