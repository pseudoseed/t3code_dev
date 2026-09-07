import type { EnvironmentId, McpAuthInput } from "@t3tools/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useId, useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { mcpEnvironment } from "../../state/mcp";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function McpAuthControls({
  environmentId,
  input,
  onChanged,
}: {
  environmentId: EnvironmentId;
  input: McpAuthInput;
  onChanged: () => void;
}) {
  const callbackId = useId();
  const target = { environmentId, input };
  const query = useEnvironmentQuery(mcpEnvironment.authSubscribe(target));
  const auth = query.data;
  const options = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(mcpEnvironment.authStart, options);
  const complete = useAtomCommand(mcpEnvironment.authComplete, options);
  const cancel = useAtomCommand(mcpEnvironment.authCancel, options);
  const logout = useAtomCommand(mcpEnvironment.authLogout, options);
  const { copyToClipboard } = useCopyToClipboard<string>();
  const [callback, setCallback] = useState({ flowId: "", value: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const active = auth && ["starting", "waiting", "verifying"].includes(auth.phase);
  const callbackUrl = callback.flowId === auth?.flowId ? callback.value : "";

  useEffect(() => {
    if (auth?.phase === "succeeded") onChanged();
  }, [auth?.phase, onChanged]);

  async function run<A, E>(operation: () => Promise<AtomCommandResult<A, E>>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Connector sign-in failed.");
      } else onChanged();
    } catch {
      setError("Connector sign-in failed. Try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3 text-sm">
      <p role="status" className="text-muted-foreground">
        {auth?.message ?? "Sign in to this connector for this account."}
      </p>
      {auth?.phase === "succeeded" ? (
        <p className="text-muted-foreground">Start a new conversation to reconnect its tools.</p>
      ) : null}
      {auth?.authorizationUrl ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() =>
                void ensureLocalApi()
                  .shell.openExternal(auth.authorizationUrl!)
                  .catch(() => setError("Could not open the page. Copy the sign-in link."))
              }
            >
              Open sign-in page
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => copyToClipboard(auth.authorizationUrl!, auth.authorizationUrl!)}
            >
              Copy sign-in link
            </Button>
          </div>
          {auth.completion !== "none" ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (auth.flowId && callbackUrl.trim())
                  void run(() =>
                    complete({
                      environmentId,
                      input: { ...input, flowId: auth.flowId!, callbackUrl: callbackUrl.trim() },
                    }),
                  );
              }}
            >
              <label className="block" htmlFor={callbackId}>
                If the final localhost page does not load, paste its full URL here.
              </label>
              <Input
                id={callbackId}
                type="url"
                autoComplete="off"
                spellCheck={false}
                maxLength={16_384}
                value={callbackUrl}
                onChange={(event) =>
                  setCallback({ flowId: auth.flowId ?? "", value: event.target.value })
                }
                placeholder="http://localhost:…"
              />
              <Button size="sm" type="submit" disabled={busy || !callbackUrl.trim()}>
                Complete sign-in
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {active ? (
          auth?.flowId ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(() => cancel({ environmentId, input: { ...input, flowId: auth.flowId! } }))
              }
            >
              Cancel sign-in
            </Button>
          ) : null
        ) : (
          <>
            <Button
              size="sm"
              disabled={busy || !auth}
              onClick={() => void run(() => start(target))}
            >
              Sign in
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !auth}
              onClick={() => void run(() => logout(target))}
            >
              Sign out
            </Button>
          </>
        )}
      </div>
      {error || query.error ? (
        <p role="alert" className="text-destructive">
          {error ?? query.error}
        </p>
      ) : null}
    </div>
  );
}
