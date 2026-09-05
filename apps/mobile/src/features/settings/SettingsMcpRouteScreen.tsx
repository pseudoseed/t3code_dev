import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  McpInstanceInventory,
  McpMutationResult,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useEnvironments } from "../../state/environments";
import { mcpEnvironment } from "../../state/mcp";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

const PRIVATE_COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;
const ADD_JSON_PLACEHOLDER = '{"type":"http","url":"https://mcp.example.com/mcp"}';

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

function outcomeSummary(outcomes: ReadonlyArray<{ ok: boolean; message: string }>): string {
  const failures = outcomes.filter((outcome) => !outcome.ok);
  if (failures.length === 0) return `Applied to ${outcomes.length} account(s).`;
  return failures.map((failure) => failure.message || "Failed").join(" · ");
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

function AccountChips(props: {
  readonly instances: ReadonlyArray<McpInstanceInventory>;
  readonly presentIn: ReadonlyArray<ProviderInstanceId>;
}) {
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {props.instances.map((instance) => {
        const present = props.presentIn.includes(instance.instanceId);
        return (
          <View
            key={instance.instanceId}
            className={cn(
              "rounded-full px-2 py-0.5",
              present ? "bg-foreground/12" : "bg-transparent border border-border",
            )}
          >
            <Text
              className={cn(
                "text-xs",
                present ? "text-foreground" : "text-foreground-muted opacity-60",
              )}
            >
              {instance.displayName}
            </Text>
          </View>
        );
      })}
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
  const removeServer = useAtomCommand(mcpEnvironment.remove, PRIVATE_COMMAND_OPTIONS);

  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [json, setJson] = useState("");

  const instances = data?.instances ?? [];
  const rows = buildServerRows(instances);

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
          : "Failed. Check that this account's Claude binary path is correct.",
      );
      refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!isPending && instances.length === 0 && error === null) {
    return (
      <SettingsSection title={props.label}>
        <View className="p-4">
          <Text className="text-base text-foreground-muted">
            No Claude accounts are configured on this machine.
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
        {rows.map((row) => {
          const missing = instances.filter(
            (instance) => !row.presentIn.includes(instance.instanceId),
          );
          return (
            <View key={row.name} className="gap-2 p-4">
              <Text className="text-base text-foreground">{row.name}</Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                {row.transport} · {row.target}
              </Text>
              <AccountChips instances={instances} presentIn={row.presentIn} />
              <View className="flex-row gap-2">
                {missing.length > 0 ? (
                  <ActionButton
                    label={`Copy to ${missing.length} more`}
                    disabled={busy}
                    onPress={() =>
                      void runMutation(() =>
                        copyServer({
                          environmentId: props.environmentId,
                          input: {
                            fromInstanceId: row.presentIn[0]!,
                            toInstanceIds: missing.map((instance) => instance.instanceId),
                            name: row.name,
                          },
                        }),
                      )
                    }
                  />
                ) : null}
                <ActionButton
                  label="Remove"
                  destructive
                  disabled={busy}
                  onPress={() =>
                    void runMutation(() =>
                      removeServer({
                        environmentId: props.environmentId,
                        input: { instanceIds: row.presentIn, name: row.name },
                      }),
                    )
                  }
                />
              </View>
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
          <TextInput
            value={json}
            onChangeText={setJson}
            placeholder={ADD_JSON_PLACEHOLDER}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            className="min-h-24 rounded-2xl border-continuous border border-border px-3 py-2 text-base text-foreground"
          />
          <Text className="text-sm text-foreground-muted">
            Applied to every Claude account on this machine.
          </Text>
          <ActionButton
            label="Add"
            disabled={busy || name.trim().length === 0 || json.trim().length === 0}
            onPress={() =>
              void runMutation(async () => {
                const result = await addServer({
                  environmentId: props.environmentId,
                  input: {
                    instanceIds: instances.map((instance) => instance.instanceId),
                    name: name.trim(),
                    json: json.trim(),
                  },
                });
                setName("");
                setJson("");
                return result;
              })
            }
          />
        </View>
      </SettingsSection>

      <SettingsSection title="Sign in to a connector">
        {instances.map((instance) => (
          <Pressable
            key={instance.instanceId}
            accessibilityRole="button"
            accessibilityLabel={`Copy command for ${instance.displayName}`}
            onPress={() => void tryCopyTextWithHaptic(instance.cliPrefix, { target: "command" })}
            className="flex-row items-center gap-3 p-4 active:opacity-70"
          >
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-base text-foreground">{instance.displayName}</Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                {instance.cliPrefix}
              </Text>
              {instance.requiredEnvNames.length > 0 ? (
                <Text className="text-sm text-foreground-muted opacity-70">
                  Also needs {instance.requiredEnvNames.join(", ")} in your shell.
                </Text>
              ) : null}
            </View>
            <SymbolView name="doc.on.doc" size={16} tintColorClassName="accent-icon" />
          </Pressable>
        ))}
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
          Typing /mcp in a conversation does nothing. It is a command the Claude terminal handles
          itself, and conversations run Claude without a terminal attached.
        </Text>
      </ScrollView>
    </View>
  );
}
