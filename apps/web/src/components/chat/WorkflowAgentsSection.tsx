import type { EnvironmentId, OrchestrationV2Subagent, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { formatTokens } from "@t3tools/shared/usageFormat";

function WorkflowScript({
  environmentId,
  threadId,
  scriptPath,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  scriptPath: string;
}) {
  const query = useEnvironmentQuery(
    orchestrationEnvironment.workflowScript({
      environmentId,
      input: { threadId, scriptPath },
    }),
  );
  return (
    <div className="max-h-72 overflow-auto p-2">
      {query.data ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-2xs">
          {query.data.contents}
          {query.data.truncated ? "\n… (truncated)" : ""}
        </pre>
      ) : (
        <p className="text-xs text-muted-foreground">
          {query.error ? "Could not load the script." : "Loading script…"}
        </p>
      )}
    </div>
  );
}

function WorkflowMembers({
  title,
  members,
}: {
  title: string;
  members: readonly OrchestrationV2Subagent[];
}) {
  const [open, setOpen] = useState(() =>
    members.some((member) => ["running", "waiting", "pending"].includes(member.status)),
  );
  return (
    <div className="grid gap-1">
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {title} · {members.length}
      </Button>
      {open ? (
        <ul className="grid max-h-64 gap-1 overflow-y-auto px-2">
          {members.map((member) => (
            <li key={member.id} className="grid gap-0.5 py-1">
              <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
                <span className="truncate">{member.title ?? "Agent"}</span>
                <span className="shrink-0 text-muted-foreground">{member.status}</span>
              </div>
              <p className="truncate text-2xs text-muted-foreground">
                {member.taskMetadata?.error ??
                  member.progress ??
                  member.taskMetadata?.lastToolName ??
                  "\u00a0"}
              </p>
              <div className="flex gap-2 text-2xs text-muted-foreground">
                {member.model ? <span className="truncate">{member.model}</span> : null}
                {member.taskMetadata?.usage ? (
                  <span className="shrink-0 tabular-nums">
                    {formatTokens(member.taskMetadata.usage.totalTokens)} tokens
                  </span>
                ) : null}
                {member.taskMetadata?.usage?.toolUses !== undefined ? (
                  <span className="shrink-0 tabular-nums">
                    {member.taskMetadata.usage.toolUses} tools
                  </span>
                ) : null}
                {(member.taskMetadata?.attempt ?? 0) > 1 ? (
                  <span>Attempt {member.taskMetadata?.attempt}</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Workflow members have stable slots and no independently navigable native thread. */
export function WorkflowAgentsSection({
  coordinator,
  members,
  environmentId,
  threadId,
}: {
  coordinator: OrchestrationV2Subagent;
  members: readonly OrchestrationV2Subagent[];
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const [showScript, setShowScript] = useState(false);
  const metadata = coordinator.taskMetadata;
  const phases = metadata?.phases ?? [];
  const phaseIds = new Set(phases.map((phase) => phase.index));
  const ungrouped = members.filter(
    (member) => !phaseIds.has(member.taskMetadata?.phaseIndex ?? -1),
  );
  const scriptPath = metadata?.runHandles?.scriptPath;
  return (
    <section className="grid gap-1 border-t border-border/60 py-2">
      <div className="flex items-center justify-between gap-2 px-2">
        <h4 className="truncate text-xs font-medium">
          {metadata?.workflowName ?? coordinator.title ?? "Workflow"}
        </h4>
        {scriptPath ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setShowScript((value) => !value)}
            aria-expanded={showScript}
          >
            {showScript ? "Hide script" : "View script"}
          </Button>
        ) : null}
      </div>
      {showScript && scriptPath ? (
        <WorkflowScript environmentId={environmentId} threadId={threadId} scriptPath={scriptPath} />
      ) : null}
      {phases.map((phase) => (
        <WorkflowMembers
          key={phase.index}
          title={phase.title}
          members={members.filter((member) => member.taskMetadata?.phaseIndex === phase.index)}
        />
      ))}
      {ungrouped.length > 0 ? (
        <WorkflowMembers
          title={phases.length > 0 ? "Other agents" : "Agents"}
          members={ungrouped}
        />
      ) : null}
    </section>
  );
}
