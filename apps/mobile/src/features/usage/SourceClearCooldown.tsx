import type { EnvironmentId, UsageLimitSourceClearCooldownInput } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function SourceClearCooldown({
  environmentId,
  input,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly input: UsageLimitSourceClearCooldownInput;
  readonly label?: string | undefined;
}) {
  const clearCooldown = useAtomCommand(serverEnvironment.clearSourceCooldown, {
    reportFailure: false,
  });
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const clear = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setStatus(null);
    try {
      const result = await clearCooldown({ environmentId, input });
      setStatus(
        result._tag === "Success"
          ? "Proxy cooldown cleared. Retry your request."
          : "error" in result.cause && result.cause.error instanceof Error
            ? result.cause.error.message
            : "Could not clear the proxy cooldown.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <View className="gap-2 border-t border-border-subtle pt-3">
      {label ? <Text className="text-xs text-foreground-muted">{label}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy, busy }}
        disabled={busy}
        onPress={() => void clear()}
        className="min-h-11 items-center justify-center rounded-full bg-subtle-strong px-3 py-2"
      >
        <Text className="text-sm font-t3-medium text-foreground">
          {busy ? "Clearing…" : "Clear cooldown"}
        </Text>
      </Pressable>
      <Text className="text-xs text-foreground-muted">
        Clear a stale proxy block after resetting quota. No reset credit is used.
      </Text>
      {status ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
          {status}
        </Text>
      ) : null}
    </View>
  );
}
