import { CopyIcon, PlusIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import type {
  McpInstanceInventory,
  McpMutationResult,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { mcpEnvironment } from "../../state/mcp";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { usePrimaryEnvironment } from "../../state/environments";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const ADD_JSON_PLACEHOLDER = `{"type":"http","url":"https://mcp.example.com/mcp"}`;

/**
 * One server, plus which instances currently have it. Grouping this way is the
 * point of the page: with several signed-in accounts the useful question is
 * never "what does this account have" but "which accounts are missing this".
 */
interface ServerRow {
  readonly name: string;
  readonly transport: string;
  readonly target: string;
  readonly envKeys: ReadonlyArray<string>;
  readonly headerKeys: ReadonlyArray<string>;
  readonly presentIn: ReadonlyArray<ProviderInstanceId>;
}

function buildServerRows(instances: ReadonlyArray<McpInstanceInventory>): ServerRow[] {
  const rows = new Map<string, ServerRow>();
  for (const instance of instances) {
    for (const server of instance.servers) {
      const existing = rows.get(server.name);
      if (existing) {
        rows.set(server.name, {
          ...existing,
          presentIn: [...existing.presentIn, instance.instanceId],
        });
        continue;
      }
      rows.set(server.name, {
        name: server.name,
        transport: server.transport,
        target: server.target,
        envKeys: server.envKeys,
        headerKeys: server.headerKeys,
        presentIn: [instance.instanceId],
      });
    }
  }
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function outcomeSummary(outcomes: ReadonlyArray<{ ok: boolean; message: string }>): string {
  const failures = outcomes.filter((outcome) => !outcome.ok);
  if (failures.length === 0) return `Applied to ${outcomes.length} instance(s).`;
  return failures.map((failure) => failure.message || "Failed").join(" · ");
}

function InstanceChips({
  instances,
  presentIn,
}: {
  instances: ReadonlyArray<McpInstanceInventory>;
  presentIn: ReadonlyArray<ProviderInstanceId>;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {instances.map((instance) => {
        const present = presentIn.includes(instance.instanceId);
        return (
          <Badge
            key={instance.instanceId}
            variant={present ? "default" : "outline"}
            className={cn(!present && "text-muted-foreground/70 line-through")}
          >
            {instance.displayName}
          </Badge>
        );
      })}
    </div>
  );
}

export function McpSettingsPanel() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null ? null : mcpEnvironment.inventory({ environmentId, input: {} }),
  );
  const addServer = useAtomCommand(mcpEnvironment.add, { reportFailure: false });
  const copyServer = useAtomCommand(mcpEnvironment.copy, { reportFailure: false });
  const removeServer = useAtomCommand(mcpEnvironment.remove, { reportFailure: false });
  const { copyToClipboard } = useCopyToClipboard<string>();

  const instances = useMemo(() => data?.instances ?? [], [data]);
  const rows = useMemo(() => buildServerRows(instances), [instances]);

  const [name, setName] = useState("");
  const [json, setJson] = useState("");
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedInstanceIds = useMemo(
    () =>
      instances
        .map((instance) => instance.instanceId)
        .filter((instanceId) => !excluded.has(instanceId)),
    [excluded, instances],
  );

  const toggleInstance = useCallback((instanceId: string) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(instanceId)) next.delete(instanceId);
      else next.add(instanceId);
      return next;
    });
  }, []);

  // Every mutation ends with a refresh: the write goes through the Claude CLI,
  // so the config on disk is the only thing that knows what actually landed.
  const runMutation = async (
    operation: () => Promise<AtomCommandResult<McpMutationResult, unknown>>,
  ) => {
    setBusy(true);
    setStatus(null);
    try {
      const result = await operation();
      setStatus(
        result._tag === "Success"
          ? outcomeSummary(result.value.outcomes)
          : "Failed. Check that this instance's Claude binary path is correct.",
      );
      refresh();
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    environmentId !== null &&
    name.trim().length > 0 &&
    json.trim().length > 0 &&
    selectedInstanceIds.length > 0 &&
    !busy;

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="mcp-servers"
        title="MCP servers"
        description="Each signed-in Claude account keeps its own configuration directory, so a server has to be added per account. Changes here run through the Claude CLI."
        headerAction={
          <Button variant="ghost" size="sm" onClick={refresh} disabled={isPending}>
            <RefreshCwIcon className={cn("size-3.5", isPending && "animate-spin")} />
            Refresh
          </Button>
        }
      >
        {error ? <p className="px-3 text-sm text-destructive sm:px-4">{error}</p> : null}
        {status ? <p className="px-3 text-sm text-muted-foreground sm:px-4">{status}</p> : null}
        {instances.length === 0 && !isPending ? (
          <p className="px-3 text-sm text-muted-foreground sm:px-4">
            No Claude provider instances are configured on this environment.
          </p>
        ) : null}

        <div className="divide-y divide-border/60">
          {rows.map((row) => {
            const missing = instances.filter(
              (instance) => !row.presentIn.includes(instance.instanceId),
            );
            return (
              <div key={row.name} className="space-y-2 px-3 py-3 sm:px-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{row.name}</p>
                    <p className="truncate text-[13px] text-muted-foreground/80">
                      {row.transport} · {row.target}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {missing.length > 0 ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void runMutation(() =>
                            copyServer({
                              environmentId: environmentId!,
                              input: {
                                fromInstanceId: row.presentIn[0]!,
                                toInstanceIds: missing.map((instance) => instance.instanceId),
                                name: row.name,
                              },
                            }),
                          )
                        }
                      >
                        Copy to {missing.length} more
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Remove ${row.name} everywhere`}
                      onClick={() =>
                        void runMutation(() =>
                          removeServer({
                            environmentId: environmentId!,
                            input: { instanceIds: row.presentIn, name: row.name },
                          }),
                        )
                      }
                    >
                      <TrashIcon className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <InstanceChips instances={instances} presentIn={row.presentIn} />
                {row.envKeys.length > 0 || row.headerKeys.length > 0 ? (
                  <p className="text-[12px] text-muted-foreground/70">
                    Carries credentials: {[...row.envKeys, ...row.headerKeys].join(", ")}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        id="mcp-add"
        title="Add a server"
        description="Paste the same JSON you would pass to claude mcp add-json."
      >
        <div className="space-y-3 px-3 py-3 sm:px-4">
          <div className="space-y-1.5">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              value={name}
              placeholder="sentry"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcp-json">Definition</Label>
            <Textarea
              id="mcp-json"
              rows={4}
              value={json}
              placeholder={ADD_JSON_PLACEHOLDER}
              onChange={(event) => setJson(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Apply to</Label>
            <div className="flex flex-col gap-1.5">
              {instances.map((instance) => (
                <label key={instance.instanceId} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={!excluded.has(instance.instanceId)}
                    onCheckedChange={() => toggleInstance(instance.instanceId)}
                  />
                  {instance.displayName}
                </label>
              ))}
            </div>
          </div>
          <Button
            disabled={!canSubmit}
            onClick={() =>
              void runMutation(async () => {
                const result = await addServer({
                  environmentId: environmentId!,
                  input: { instanceIds: selectedInstanceIds, name: name.trim(), json: json.trim() },
                });
                setName("");
                setJson("");
                return result;
              })
            }
          >
            <PlusIcon className="size-3.5" />
            Add
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="mcp-terminal"
        title="Sign in to a connector"
        description="Servers that authorize through a browser need the interactive Claude CLI, which T3 Code cannot run for you. Copy an account's command, run it in a terminal, then use /mcp there."
      >
        <div className="divide-y divide-border/60">
          {instances.map((instance) => (
            <div
              key={instance.instanceId}
              className="flex items-center justify-between gap-3 px-3 py-2.5 sm:px-4"
            >
              <div className="min-w-0">
                <p className="text-sm">{instance.displayName}</p>
                <code className="block truncate text-[12px] text-muted-foreground/80">
                  {instance.cliPrefix}
                </code>
                {instance.requiredEnvNames.length > 0 ? (
                  <p className="text-[12px] text-muted-foreground/70">
                    Signed in through {instance.requiredEnvNames.join(", ")}. Set that in your shell
                    too, or the CLI starts as a signed-out account and asks you to log in.
                  </p>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Copy command for ${instance.displayName}`}
                onClick={() => copyToClipboard(instance.cliPrefix, instance.cliPrefix)}
              >
                <CopyIcon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
