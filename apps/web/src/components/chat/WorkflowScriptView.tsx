import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";

export function WorkflowScriptView({
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
