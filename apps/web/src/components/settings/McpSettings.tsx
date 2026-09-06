import { PlusIcon, RefreshCwIcon } from "lucide-react";
import type {
  EnvironmentId,
  McpInstanceInventory,
  McpMutationResult,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { mcpAuthStatusLabel, mcpOutcomeSummary } from "@t3tools/client-runtime/state/mcp";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useId, useMemo, useRef, useState } from "react";

import { mcpEnvironment } from "../../state/mcp";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironments } from "../../state/environments";
import { McpAuthControls } from "./McpAuthControls";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const ADD_JSON_PLACEHOLDER = `{"type":"http","url":"https://mcp.example.com/mcp"}`;

const DRIVER_LABELS: Readonly<Record<string, string>> = {
  claudeAgent: "Claude",
  codex: "Codex",
};

function driverLabel(driver: string): string {
  return DRIVER_LABELS[driver] ?? driver;
}

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

export function McpSettingsPanel() {
  const { environments } = useEnvironments();
  return (
    <>
      {environments.map((environment) => (
        <EnvironmentMcpSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
        />
      ))}
      {environments.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          Connect to an environment to manage MCP servers.
        </p>
      ) : null}
    </>
  );
}

function EnvironmentMcpSettings({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null ? null : mcpEnvironment.inventory({ environmentId, input: {} }),
  );
  const formId = useId();
  const pending = useRef(false);
  const addServer = useAtomCommand(mcpEnvironment.add, { reportFailure: false });
  const copyServer = useAtomCommand(mcpEnvironment.copy, { reportFailure: false });
  const removeServer = useAtomCommand(mcpEnvironment.remove, { reportFailure: false });
  const repair = useAtomCommand(mcpEnvironment.repair, {
    reportFailure: false,
    reportDefect: false,
  });
  const [authTarget, setAuthTarget] = useState<{
    instanceId: ProviderInstanceId;
    name: string;
  } | null>(null);

  const instances = useMemo(() => data?.instances ?? [], [data]);
  const rows = useMemo(() => buildServerRows(instances), [instances]);

  const [name, setName] = useState("");
  const [json, setJson] = useState("");
  const [url, setUrl] = useState("");
  const [advanced, setAdvanced] = useState(false);
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
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setStatus(null);
    try {
      const result = await operation();
      setStatus(
        result._tag === "Success"
          ? mcpOutcomeSummary(result.value.outcomes, instances)
          : String(squashAtomCommandFailure(result)),
      );
      refresh();
    } catch {
      setStatus("Could not update this server. Try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const definition = advanced ? json.trim() : JSON.stringify({ type: "http", url: url.trim() });
  const canSubmit =
    environmentId !== null &&
    name.trim().length > 0 &&
    (advanced ? json.trim().length > 0 : /^https?:\/\//.test(url.trim())) &&
    selectedInstanceIds.length > 0 &&
    !busy;

  return (
    <SettingsPageContainer>
      <SettingsSection
        id={`mcp-servers-${formId}`}
        title={`MCP servers · ${label}`}
        description="Add servers, manage connector sign-ins, and repair missing refresh credentials for each account. After changing a connection, start a new conversation to load its tools."
        headerAction={
          <Button variant="ghost" size="sm" onClick={refresh} disabled={isPending}>
            <RefreshCwIcon className="size-3.5" />
            Refresh
          </Button>
        }
      >
        {error ? <p className="px-3 text-sm text-destructive sm:px-4">{error}</p> : null}
        {status ? (
          <p role="status" className="px-3 text-sm text-muted-foreground sm:px-4">
            {status}
          </p>
        ) : null}
        {instances.length === 0 && !isPending ? (
          <p className="px-3 text-sm text-muted-foreground sm:px-4">
            No Claude or Codex accounts are configured on this environment.
          </p>
        ) : null}

        {instances
          .filter((instance) => instance.readError)
          .map((instance) => (
            <p role="alert" key={instance.instanceId} className="px-4 text-sm text-destructive">
              {instance.displayName}: {instance.readError}
            </p>
          ))}
        {rows.length === 0 && !isPending && instances.length > 0 ? (
          <p className="px-4 text-sm text-muted-foreground">
            No servers configured. Add a URL below to get started.
          </p>
        ) : null}
        <div className="divide-y divide-border/60">
          {rows.map((row) => {
            const source = instances.find((instance) =>
              instance.servers.some(
                (server) => server.name === row.name && server.canManageDefinition !== false,
              ),
            );
            const missing = instances.filter(
              (instance) => !instance.readError && !row.presentIn.includes(instance.instanceId),
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
                    {source && missing.length > 0 ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void runMutation(() =>
                            copyServer({
                              environmentId: environmentId!,
                              input: {
                                fromInstanceId: source.instanceId,
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
                  </div>
                </div>
                {instances
                  .filter((instance) => row.presentIn.includes(instance.instanceId))
                  .map((instance) => {
                    const server = instance.servers.find((server) => server.name === row.name)!;
                    const canAuth = server.transport !== "stdio";
                    const selected =
                      authTarget?.instanceId === instance.instanceId &&
                      authTarget.name === row.name;
                    return (
                      <div
                        key={instance.instanceId}
                        className="space-y-2 rounded-md bg-muted/30 p-2"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">
                            {driverLabel(instance.driver)} · {instance.displayName}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {mcpAuthStatusLabel(server.authStatus)}
                          </span>
                          {canAuth ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                setAuthTarget({ instanceId: instance.instanceId, name: row.name })
                              }
                            >
                              Manage sign-in
                            </Button>
                          ) : null}
                          {instance.driver === "claudeAgent" &&
                          (server.authStatus === "incomplete" ||
                            server.authStatus === "needsAuth") ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                void runMutation(() =>
                                  repair({
                                    environmentId,
                                    input: { instanceIds: [instance.instanceId], name: row.name },
                                  }),
                                )
                              }
                            >
                              Repair from default Claude
                            </Button>
                          ) : null}
                          {server.canManageDefinition !== false ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() =>
                                void runMutation(() =>
                                  removeServer({
                                    environmentId,
                                    input: { instanceIds: [instance.instanceId], name: row.name },
                                  }),
                                )
                              }
                            >
                              Remove
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              Managed by a plugin or connector
                            </span>
                          )}
                        </div>
                        {server.target !== row.target ? (
                          <p className="break-all text-xs text-muted-foreground">{server.target}</p>
                        ) : null}
                        {selected ? (
                          <McpAuthControls
                            key={`${instance.instanceId}:${row.name}`}
                            environmentId={environmentId}
                            input={authTarget}
                            onChanged={refresh}
                          />
                        ) : null}
                      </div>
                    );
                  })}
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
        id={`mcp-add-${formId}`}
        title="Add a server"
        description="Enter a server URL and choose its accounts. Use JSON for a local command or custom headers."
      >
        <div className="space-y-3 px-3 py-3 sm:px-4">
          <div className="space-y-1.5">
            <Label htmlFor={`mcp-name-${formId}`}>Name</Label>
            <Input
              id={`mcp-name-${formId}`}
              value={name}
              placeholder="sentry"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Button size="sm" variant="ghost" onClick={() => setAdvanced(!advanced)}>
              {advanced ? "Use server URL" : "Use JSON definition"}
            </Button>
            {advanced ? (
              <>
                <Label htmlFor={`mcp-json-${formId}`}>Definition</Label>
                <Textarea
                  id={`mcp-json-${formId}`}
                  rows={4}
                  value={json}
                  placeholder={ADD_JSON_PLACEHOLDER}
                  onChange={(event) => setJson(event.target.value)}
                />
              </>
            ) : (
              <>
                <Label htmlFor={`mcp-url-${formId}`}>Server URL</Label>
                <Input
                  id={`mcp-url-${formId}`}
                  type="url"
                  value={url}
                  placeholder="https://mcp.example.com/mcp"
                  onChange={(event) => setUrl(event.target.value)}
                />
              </>
            )}
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
                  {driverLabel(instance.driver)} · {instance.displayName}
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
                  input: { instanceIds: selectedInstanceIds, name: name.trim(), json: definition },
                });
                if (
                  result._tag === "Success" &&
                  result.value.outcomes.every((outcome) => outcome.ok)
                ) {
                  setName("");
                  setJson("");
                  setUrl("");
                }
                return result;
              })
            }
          >
            <PlusIcon className="size-3.5" />
            Add
          </Button>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
