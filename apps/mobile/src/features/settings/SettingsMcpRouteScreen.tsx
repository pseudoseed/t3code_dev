import { mcpAuthStatusLabel, mcpOutcomeSummary } from "@t3tools/client-runtime/state/mcp";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  McpAuthInput,
  EnvironmentId,
  McpInstanceInventory,
  McpMutationResult,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { cn } from "../../lib/cn";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useEnvironments } from "../../state/environments";
import { mcpEnvironment } from "../../state/mcp";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

const PRIVATE_COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;
const ADD_JSON_PLACEHOLDER = '{"type":"http","url":"https://mcp.example.com/mcp"}';

const DRIVER_LABELS: Readonly<Record<string, string>> = {
  claudeAgent: "Claude",
  codex: "Codex",
};

function driverLabel(driver: string): string {
  return DRIVER_LABELS[driver] ?? driver;
}

/**
 * One server, plus which accounts on this machine have it. Grouping this way
 * is the point of the screen: with several signed-in accounts the question is
 * never "what does this account have" but "which accounts are missing this".
 */
interface ServerRow {
  readonly name: string;
  readonly transport: string;
  readonly target: string;
  readonly presentIn: ReadonlyArray<ProviderInstanceId>;
}

function buildServerRows(instances: ReadonlyArray<McpInstanceInventory>): ServerRow[] {
  const rows = new Map<string, ServerRow>();
  for (const instance of instances) {
    for (const server of instance.servers) {
      const existing = rows.get(server.name);
      rows.set(
        server.name,
        existing
          ? { ...existing, presentIn: [...existing.presentIn, instance.instanceId] }
          : {
              name: server.name,
              transport: server.transport,
              target: server.target,
              presentIn: [instance.instanceId],
            },
      );
    }
  }
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function ActionButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-9 items-center justify-center rounded-full border-continuous border border-border px-3 py-1.5 active:opacity-70 disabled:opacity-40"
    >
      <Text
        className={cn(
          "text-sm font-t3-medium text-foreground",
          props.destructive && "text-red-400",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function McpAuthControls({
  environmentId,
  input,
  onChanged,
}: {
  environmentId: EnvironmentId;
  input: McpAuthInput;
  onChanged: () => void;
}) {
  const target = { environmentId, input };
  const query = useEnvironmentQuery(mcpEnvironment.authSubscribe(target));
  const auth = query.data;
  const start = useAtomCommand(mcpEnvironment.authStart, PRIVATE_COMMAND_OPTIONS);
  const complete = useAtomCommand(mcpEnvironment.authComplete, PRIVATE_COMMAND_OPTIONS);
  const cancel = useAtomCommand(mcpEnvironment.authCancel, PRIVATE_COMMAND_OPTIONS);
  const logout = useAtomCommand(mcpEnvironment.authLogout, PRIVATE_COMMAND_OPTIONS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [callback, setCallback] = useState({ flowId: "", value: "" });
  const callbackUrl = callback.flowId === auth?.flowId ? callback.value : "";
  const active = auth && ["starting", "waiting", "verifying"].includes(auth.phase);
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
    <View className="gap-2">
      <Text className="text-sm text-foreground-muted">
        {auth?.message ?? "Sign in to this connector for this account."}
      </Text>
      {auth?.phase === "succeeded" ? (
        <Text className="text-sm text-foreground-muted">
          Start a new conversation to reconnect its tools.
        </Text>
      ) : null}
      {auth?.authorizationUrl ? (
        <>
          <ActionButton
            label="Open sign-in page"
            onPress={() => void tryOpenExternalUrl(auth.authorizationUrl!, "provider-auth")}
          />
          <ActionButton
            label="Copy sign-in link"
            onPress={() =>
              void tryCopyTextWithHaptic(auth.authorizationUrl!, { target: "command" })
            }
          />
          {auth.completion !== "none" ? (
            <>
              <Text className="text-sm text-foreground-muted">
                If the final localhost page does not load, paste its full URL here.
              </Text>
              <TextInput
                accessibilityLabel="Sign-in redirect URL"
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={16_384}
                value={callbackUrl}
                onChangeText={(value) => setCallback({ flowId: auth.flowId ?? "", value })}
                placeholder="http://localhost:…"
                className="min-h-11 rounded-2xl border border-border px-3 text-base text-foreground"
              />
              <ActionButton
                label="Complete sign-in"
                disabled={busy || !callbackUrl.trim()}
                onPress={() => {
                  if (auth.flowId)
                    void run(() =>
                      complete({
                        environmentId,
                        input: { ...input, flowId: auth.flowId!, callbackUrl: callbackUrl.trim() },
                      }),
                    );
                }}
              />
            </>
          ) : null}
        </>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {active ? (
          auth?.flowId ? (
            <ActionButton
              label="Cancel sign-in"
              disabled={busy}
              onPress={() =>
                void run(() => cancel({ environmentId, input: { ...input, flowId: auth.flowId! } }))
              }
            />
          ) : null
        ) : (
          <>
            <ActionButton
              label="Sign in"
              disabled={busy || !auth}
              onPress={() => void run(() => start(target))}
            />
            <ActionButton
              label="Sign out"
              disabled={busy || !auth}
              onPress={() => void run(() => logout(target))}
            />
          </>
        )}
      </View>
      {error || query.error ? (
        <Text className="text-sm text-red-400">{error ?? query.error}</Text>
      ) : null}
    </View>
  );
}

/**
 * Mobile has no primary environment, so each connected machine gets its own
 * block. Accounts and their config directories belong to one machine and never
 * span them.
 */
function EnvironmentMcpSection(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    mcpEnvironment.inventory({ environmentId: props.environmentId, input: {} }),
  );
  const addServer = useAtomCommand(mcpEnvironment.add, PRIVATE_COMMAND_OPTIONS);
  const copyServer = useAtomCommand(mcpEnvironment.copy, PRIVATE_COMMAND_OPTIONS);
  const repair = useAtomCommand(mcpEnvironment.repair, PRIVATE_COMMAND_OPTIONS);
  const [authTarget, setAuthTarget] = useState<McpAuthInput | null>(null);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const removeServer = useAtomCommand(mcpEnvironment.remove, PRIVATE_COMMAND_OPTIONS);

  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [json, setJson] = useState("");
  const [url, setUrl] = useState("");
  const [advanced, setAdvanced] = useState(false);

  const instances = data?.instances ?? [];
  const rows = buildServerRows(instances);
  const selectedInstanceIds = instances
    .filter((instance) => !excluded.has(instance.instanceId))
    .map((instance) => instance.instanceId);

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
          ? mcpOutcomeSummary(result.value.outcomes, instances)
          : String(squashAtomCommandFailure(result)),
      );
      refresh();
    } catch {
      setStatus("Could not update the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!isPending && instances.length === 0 && error === null) {
    return (
      <SettingsSection title={props.label}>
        <View className="p-4">
          <Text className="text-base text-foreground-muted">
            No Claude or Codex accounts are configured on this machine.
          </Text>
        </View>
      </SettingsSection>
    );
  }

  return (
    <View className="gap-6">
      <SettingsSection title={props.label}>
        {error ? (
          <View className="p-4">
            <Text className="text-base text-red-400">{error}</Text>
          </View>
        ) : null}
        {status ? (
          <View className="px-4 pt-4">
            <Text className="text-sm text-foreground-muted">{status}</Text>
          </View>
        ) : null}
        <View className="p-4">
          <ActionButton label="Refresh" disabled={busy || isPending} onPress={refresh} />
        </View>
        {instances
          .filter((instance) => instance.readError)
          .map((instance) => (
            <Text key={instance.instanceId} className="px-4 text-sm text-red-400">
              {instance.displayName}: {instance.readError}
            </Text>
          ))}
        {rows.length === 0 && !isPending ? (
          <Text className="px-4 text-sm text-foreground-muted">
            No servers configured. Add a URL below.
          </Text>
        ) : null}
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
            <View key={row.name} className="gap-2 p-4">
              <Text className="text-base text-foreground">{row.name}</Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                {row.transport} · {row.target}
              </Text>

              <View className="flex-row gap-2">
                {source && missing.length > 0 ? (
                  <ActionButton
                    label={`Copy to ${missing.length} more`}
                    disabled={busy}
                    onPress={() =>
                      void runMutation(() =>
                        copyServer({
                          environmentId: props.environmentId,
                          input: {
                            fromInstanceId: source.instanceId,
                            toInstanceIds: missing.map((instance) => instance.instanceId),
                            name: row.name,
                          },
                        }),
                      )
                    }
                  />
                ) : null}
              </View>
              {instances
                .filter((instance) => row.presentIn.includes(instance.instanceId))
                .map((instance) => {
                  const server = instance.servers.find((server) => server.name === row.name)!;
                  const selected =
                    authTarget?.instanceId === instance.instanceId && authTarget.name === row.name;
                  return (
                    <View
                      key={instance.instanceId}
                      className="gap-2 rounded-2xl border border-border p-3"
                    >
                      <Text className="text-sm text-foreground">
                        {driverLabel(instance.driver)} · {instance.displayName}
                      </Text>
                      <Text className="text-xs text-foreground-muted">
                        {mcpAuthStatusLabel(server.authStatus)}
                      </Text>
                      {server.target !== row.target ? (
                        <Text className="text-xs text-foreground-muted">{server.target}</Text>
                      ) : null}
                      <View className="flex-row flex-wrap gap-2">
                        {server.transport !== "stdio" ? (
                          <ActionButton
                            label="Manage sign-in"
                            disabled={busy}
                            onPress={() =>
                              setAuthTarget({ instanceId: instance.instanceId, name: row.name })
                            }
                          />
                        ) : null}
                        {instance.driver === "claudeAgent" &&
                        (server.authStatus === "incomplete" ||
                          server.authStatus === "needsAuth") ? (
                          <ActionButton
                            label="Repair from default Claude"
                            disabled={busy}
                            onPress={() =>
                              void runMutation(() =>
                                repair({
                                  environmentId: props.environmentId,
                                  input: { instanceIds: [instance.instanceId], name: row.name },
                                }),
                              )
                            }
                          />
                        ) : null}
                        {server.canManageDefinition !== false ? (
                          <ActionButton
                            label="Remove"
                            destructive
                            disabled={busy}
                            onPress={() =>
                              void runMutation(() =>
                                removeServer({
                                  environmentId: props.environmentId,
                                  input: { instanceIds: [instance.instanceId], name: row.name },
                                }),
                              )
                            }
                          />
                        ) : (
                          <Text className="text-xs text-foreground-muted">
                            Managed by a plugin or connector
                          </Text>
                        )}
                      </View>
                      {selected ? (
                        <McpAuthControls
                          key={`${instance.instanceId}:${row.name}`}
                          environmentId={props.environmentId}
                          input={{ instanceId: instance.instanceId, name: row.name }}
                          onChanged={refresh}
                        />
                      ) : null}
                    </View>
                  );
                })}
            </View>
          );
        })}
      </SettingsSection>

      <SettingsSection title="Add a server">
        <View className="gap-3 p-4">
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Name"
            autoCapitalize="none"
            autoCorrect={false}
            className="min-h-11 rounded-2xl border-continuous border border-border px-3 text-base text-foreground"
          />
          <ActionButton
            label={advanced ? "Use server URL" : "Use JSON definition"}
            onPress={() => setAdvanced(!advanced)}
          />
          {advanced ? (
            <TextInput
              accessibilityLabel="Server definition"
              value={json}
              onChangeText={setJson}
              placeholder={ADD_JSON_PLACEHOLDER}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              className="min-h-24 rounded-2xl border border-border px-3 py-2 text-base text-foreground"
            />
          ) : (
            <TextInput
              accessibilityLabel="Server URL"
              value={url}
              onChangeText={setUrl}
              placeholder="https://mcp.example.com/mcp"
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-11 rounded-2xl border border-border px-3 text-base text-foreground"
            />
          )}
          <Text className="text-sm text-foreground-muted">Apply to</Text>
          {instances.map((instance) => (
            <Pressable
              key={instance.instanceId}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: !excluded.has(instance.instanceId) }}
              onPress={() =>
                setExcluded((current) => {
                  const next = new Set(current);
                  if (next.has(instance.instanceId)) next.delete(instance.instanceId);
                  else next.add(instance.instanceId);
                  return next;
                })
              }
              className="min-h-11 justify-center"
            >
              <Text className="text-sm text-foreground">
                {excluded.has(instance.instanceId) ? "□" : "☑"} {driverLabel(instance.driver)} ·{" "}
                {instance.displayName}
              </Text>
            </Pressable>
          ))}
          <ActionButton
            label="Add"
            disabled={
              busy ||
              name.trim().length === 0 ||
              selectedInstanceIds.length === 0 ||
              (advanced ? json.trim().length === 0 : !/^https?:\/\//.test(url.trim()))
            }
            onPress={() =>
              void runMutation(async () => {
                const result = await addServer({
                  environmentId: props.environmentId,
                  input: {
                    instanceIds: selectedInstanceIds,
                    name: name.trim(),
                    json: advanced
                      ? json.trim()
                      : JSON.stringify({ type: "http", url: url.trim() }),
                  },
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
          />
        </View>
      </SettingsSection>
    </View>
  );
}

export function SettingsMcpRouteScreen() {
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentInset={{ bottom: Math.max(insets.bottom, 18) }}
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4 pb-[18px]"
      >
        {environments.length === 0 ? (
          <Text className="px-2 text-base text-foreground-muted">
            Connect to a machine to manage its MCP servers.
          </Text>
        ) : null}
        {environments.map((environment) => (
          <EnvironmentMcpSection
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
          />
        ))}
        <Text className="px-2 text-sm text-foreground-muted">
          Connector credentials stay on their machine. After changing a connection, start a new
          conversation to load its tools.
        </Text>
      </ScrollView>
    </View>
  );
}
