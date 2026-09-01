import type {
  EnvironmentId,
  IssueDetail,
  IssueListEntry,
  IssueListState,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { CircleCheck, CircleDot, Loader2, Plus, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { toastManager } from "../ui/toast";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { issueEnvironment } from "~/state/issues";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  ISSUE_SORTS,
  appendIssueContext,
  issueBranchName,
  issueContextForComposer,
  ISSUE_STATE_FILTERS,
  formatCommentCount,
  labelColor,
  narrowIssues,
  sortIssues,
  type IssueSort,
} from "./issuesPanel.logic";

interface IssuesPanelProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly cwd: string;
  /** Set when a link in the transcript asked for one issue rather than the list. */
  readonly openNumber?: number | undefined;
  /** Moves on every link click, so the same issue reopens rather than being ignored. */
  readonly openRequestId?: number | undefined;
  /** Where "Add to thread" writes. Absent on a surface with no composer beside it. */
  readonly composerDraftTarget?: ScopedThreadRef | DraftId | undefined;
}

/**
 * The issues of the project the panel is beside.
 *
 * One list and one reading pane rather than two tabs: an issue is short enough to read in place,
 * and going back to the list is a single control. The composer and the state button are shown
 * only where the host said this account may write.
 */
export function IssuesPanel(props: IssuesPanelProps) {
  const [state, setState] = useState<IssueListState>("open");
  const [sort, setSort] = useState<IssueSort>("recent");
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [openNumber, setOpenNumber] = useState<number | null>(props.openNumber ?? null);
  const [composing, setComposing] = useState(false);
  const [honouredRequestId, setHonouredRequestId] = useState(props.openRequestId ?? 0);

  // A link in the transcript names an issue; the panel opens it, and opens it again if the same
  // link is clicked after the reader has navigated away from it.
  if (props.openRequestId !== undefined && props.openRequestId !== honouredRequestId) {
    setHonouredRequestId(props.openRequestId);
    setOpenNumber(props.openNumber ?? null);
  }

  const listQuery = useEnvironmentQuery(
    issueEnvironment.list({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        state,
        ...(submittedSearch.length === 0 ? {} : { query: submittedSearch }),
      },
    }),
  );

  const result = listQuery.data;
  const searchesOnHost = result?.provider?.searchesOnHost ?? false;
  const entries = useMemo(() => {
    const rows = sortIssues(result?.entries ?? [], sort);
    // A host that searched for us has already matched bodies this cannot see.
    return searchesOnHost ? rows : narrowIssues(rows, submittedSearch);
  }, [result?.entries, searchesOnHost, sort, submittedSearch]);

  const submitSearch = useCallback(() => setSubmittedSearch(search), [search]);
  const clearSearch = useCallback(() => {
    setSearch("");
    setSubmittedSearch("");
  }, []);

  if (openNumber !== null) {
    const repository = entries.find((entry) => entry.number === openNumber)?.repository;
    return (
      <IssueDetailView
        environmentId={props.environmentId}
        projectId={props.projectId}
        repository={repository ?? result?.entries[0]?.repository ?? ""}
        number={openNumber}
        cwd={props.cwd}
        composerDraftTarget={props.composerDraftTarget}
        onBack={() => setOpenNumber(null)}
        onChanged={listQuery.refresh}
      />
    );
  }

  if (composing) {
    return (
      <NewIssueView
        environmentId={props.environmentId}
        projectId={props.projectId}
        projectTitle={props.projectTitle}
        onCancel={() => setComposing(false)}
        onCreated={(number) => {
          setComposing(false);
          listQuery.refresh();
          setOpenNumber(number);
        }}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSearch();
                if (event.key === "Escape" && search.length > 0) clearSearch();
              }}
              placeholder={searchesOnHost ? "Search issues" : "Filter loaded issues"}
              className="h-7 pl-7 pr-7 text-xs"
              aria-label="Search issues"
            />
            {search.length > 0 ? (
              <button
                type="button"
                onClick={clearSearch}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear search"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={listQuery.refresh}
            aria-label="Refresh issues"
          >
            <RefreshCw className={cn("size-3.5", listQuery.isPending && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setComposing(true)}
            aria-label="New issue"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
          {ISSUE_STATE_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setState(filter.value)}
              className={cn(
                "rounded px-1.5 py-0.5 text-[11px] transition-colors",
                state === filter.value
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {filter.label}
            </button>
          ))}
          <span aria-hidden className="mx-0.5 h-3 w-px bg-border/70" />
          {ISSUE_SORTS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setSort(option.value)}
              className={cn(
                "rounded px-1.5 py-0.5 text-[11px] transition-colors",
                sort === option.value
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {listQuery.error !== null ? (
          <PanelMessage title="Issues could not be read." detail={listQuery.error} />
        ) : entries.length === 0 ? (
          <PanelMessage
            title={
              listQuery.isPending
                ? "Loading issues."
                : result?.provider?.configured === false
                  ? "No issue tracker here."
                  : "No issues."
            }
            detail={
              listQuery.isPending
                ? null
                : // A tracker that is off is a setting, not an empty list, and saying so stops
                  // the reader looking for issues that can never appear.
                  (result?.provider?.detail ??
                  (submittedSearch.length > 0
                    ? "Nothing matched that search."
                    : `Nothing open in ${props.projectTitle}.`))
            }
          />
        ) : (
          <ul className="divide-y divide-border/40">
            {entries.map((entry) => (
              <IssueRow
                key={entry.number}
                entry={entry}
                onOpen={() => setOpenNumber(entry.number)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function IssueRow(props: { readonly entry: IssueListEntry; readonly onOpen: () => void }) {
  const { entry } = props;
  const comments = formatCommentCount(entry.commentCount);
  return (
    <li>
      <button
        type="button"
        onClick={props.onOpen}
        className="flex w-full flex-col gap-1 px-3 py-2 text-left transition-colors hover:bg-muted/50"
      >
        <div className="flex items-start gap-2">
          <StateIcon state={entry.state} />
          <span className="min-w-0 flex-1 text-xs leading-snug text-foreground">{entry.title}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-5 text-[11px] text-muted-foreground">
          <span>#{entry.number}</span>
          {entry.author ? <span>{entry.author.login}</span> : null}
          {comments ? <span>{comments}</span> : null}
          {entry.labels.slice(0, 3).map((label) => (
            <span
              key={label.name}
              className="rounded-full border border-border/60 px-1.5 py-px"
              style={
                labelColor(label.color) === undefined
                  ? undefined
                  : { borderColor: labelColor(label.color), color: labelColor(label.color) }
              }
            >
              {label.name}
            </span>
          ))}
        </div>
      </button>
    </li>
  );
}

function StateIcon(props: { readonly state: IssueDetail["state"] }) {
  return props.state === "closed" ? (
    <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-purple-500 dark:text-purple-300/90" />
  ) : (
    <CircleDot className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-300/90" />
  );
}

function PanelMessage(props: { readonly title: string; readonly detail: string | null }) {
  return (
    <div className="px-3 py-6 text-center">
      <p className="text-xs text-foreground">{props.title}</p>
      {props.detail === null ? null : (
        <p className="mt-1 text-[11px] text-muted-foreground">{props.detail}</p>
      )}
    </div>
  );
}

function IssueDetailView(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly repository: string;
  readonly number: number;
  readonly cwd: string;
  readonly composerDraftTarget?: ScopedThreadRef | DraftId | undefined;
  readonly onBack: () => void;
  readonly onChanged: () => void;
}) {
  const reference = useMemo(
    () => ({
      projectId: props.projectId,
      repository: props.repository,
      number: props.number,
    }),
    [props.projectId, props.repository, props.number],
  );
  const detailQuery = useEnvironmentQuery(
    issueEnvironment.detail({ environmentId: props.environmentId, input: reference }),
  );
  const comment = useAtomCommand(issueEnvironment.comment, { reportFailure: true });
  const setState = useAtomCommand(issueEnvironment.setState, { reportFailure: true });
  const newThread = useNewThreadHandler();
  const [starting, setStarting] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<"comment" | "state" | null>(null);

  const detail = detailQuery.data;

  const postComment = useCallback(async () => {
    const body = draft.trim();
    if (body.length === 0 || pending !== null) return;
    setPending("comment");
    const result = await comment({
      environmentId: props.environmentId,
      input: { ...reference, body },
    });
    setPending(null);
    // The draft is kept on failure: the reader's words are the one thing worth not losing.
    if (result._tag === "Success") setDraft("");
  }, [comment, draft, pending, props.environmentId, reference]);

  const toggleState = useCallback(async () => {
    if (!detail || pending !== null) return;
    setPending("state");
    const result = await setState({
      environmentId: props.environmentId,
      input: { ...reference, state: detail.state === "open" ? "closed" : "open" },
    });
    setPending(null);
    if (result._tag === "Success") props.onChanged();
  }, [detail, pending, props, reference, setState]);

  /**
   * Opens a thread on this project, on a branch named for the issue, with the issue already in
   * its composer. Nothing is sent: the reader reads what is there and decides.
   */
  const startWork = useCallback(async () => {
    if (!detail || starting) return;
    setStarting(true);
    const opened = await newThread(scopeProjectRef(props.environmentId, props.projectId), {
      branch: issueBranchName(detail),
    }).then(
      (result) => result,
      () => null,
    );
    setStarting(false);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: "Could not open a thread",
        description: "Try again from the project, or open a thread first.",
      });
      return;
    }
    const store = useComposerDraftStore.getState();
    const current = store.getComposerDraft(opened.draftId)?.prompt ?? "";
    store.setPrompt(opened.draftId, appendIssueContext(current, issueContextForComposer(detail)));
    toastManager.add({
      type: "success",
      title: "Thread opened",
      description: "The issue is in the composer. Read it over, then send.",
    });
  }, [detail, newThread, props.environmentId, props.projectId, starting]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={props.onBack}>
          Back
        </Button>
        <span className="text-[11px] text-muted-foreground">#{props.number}</span>
        <div className="flex-1" />
        {detail !== null ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={starting}
            onClick={() => void startWork()}
          >
            {starting ? <Loader2 className="size-3 animate-spin" /> : "Start work"}
          </Button>
        ) : null}
        {detail !== null && props.composerDraftTarget !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              const store = useComposerDraftStore.getState();
              const target = props.composerDraftTarget;
              if (target === undefined) return;
              const current = store.getComposerDraft(target)?.prompt ?? "";
              store.setPrompt(target, appendIssueContext(current, issueContextForComposer(detail)));
            }}
          >
            Add to thread
          </Button>
        ) : null}
        {detail?.capabilities.close && detail.viewerCanWrite ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => void toggleState()}
            disabled={pending !== null}
          >
            {detail.state === "open" ? "Close" : "Reopen"}
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {detailQuery.error !== null ? (
          <PanelMessage title="This issue could not be read." detail={detailQuery.error} />
        ) : detail === null ? (
          <PanelMessage title="Loading." detail={null} />
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-start gap-2">
                <StateIcon state={detail.state} />
                <h2 className="min-w-0 flex-1 text-sm font-medium leading-snug">{detail.title}</h2>
              </div>
              <p className="pl-5 text-[11px] text-muted-foreground">
                {detail.author?.login ?? "unknown"} opened this in {detail.repository}
              </p>
            </div>

            {detail.body.trim().length > 0 ? (
              <ChatMarkdown
                text={detail.body}
                cwd={props.cwd}
                environmentId={props.environmentId}
              />
            ) : (
              <p className="text-[11px] text-muted-foreground">No description.</p>
            )}

            {detail.comments.map((entry) => (
              <div key={entry.id} className="rounded border border-border/50 px-2.5 py-2">
                <p className="mb-1 text-[11px] text-muted-foreground">
                  {entry.author?.login ?? "unknown"}
                </p>
                <ChatMarkdown
                  text={entry.body}
                  cwd={props.cwd}
                  environmentId={props.environmentId}
                />
              </div>
            ))}

            {detail.commentsTruncated ? (
              <p className="text-[11px] text-muted-foreground">
                This conversation is longer than what is shown.
              </p>
            ) : null}
          </div>
        )}
      </div>

      {detail?.capabilities.comment && detail.viewerCanWrite ? (
        <div className="shrink-0 border-t border-border/60 p-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Leave a comment"
            rows={3}
            className="w-full resize-none rounded border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
          />
          <div className="mt-1.5 flex justify-end">
            <Button
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => void postComment()}
              disabled={draft.trim().length === 0 || pending !== null}
            >
              {pending === "comment" ? <Loader2 className="size-3 animate-spin" /> : "Comment"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NewIssueView(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly onCancel: () => void;
  readonly onCreated: (number: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const create = useAtomCommand(issueEnvironment.create, { reportFailure: true });
  const [pending, setPending] = useState(false);

  const submit = useCallback(async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || pending) return;
    setPending(true);
    const result = await create({
      environmentId: props.environmentId,
      input: {
        projectId: props.projectId,
        title: trimmed,
        ...(body.trim().length === 0 ? {} : { body }),
      },
    });
    setPending(false);
    // The draft stays on screen where it failed, so nothing typed is thrown away.
    if (result._tag === "Success") props.onCreated(result.value.number);
  }, [body, create, pending, props, title]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={props.onCancel}>
          Cancel
        </Button>
        <span className="text-[11px] text-muted-foreground">New issue in {props.projectTitle}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Title"
          className="h-7 text-xs"
          aria-label="Issue title"
        />
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Description (optional)"
          rows={10}
          className="w-full resize-none rounded border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
          aria-label="Issue description"
        />
      </div>
      <div className="shrink-0 border-t border-border/60 p-2">
        <div className="flex justify-end">
          <Button
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => void submit()}
            disabled={title.trim().length === 0 || pending}
          >
            {pending ? <Loader2 className="size-3 animate-spin" /> : "Create"}
          </Button>
        </div>
      </div>
    </div>
  );
}
