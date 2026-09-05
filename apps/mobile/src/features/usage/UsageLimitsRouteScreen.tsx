import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderConsumeResetCreditOutcome,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import {
  collectLimitSources,
  collectLimitsGroups,
  limitsNotice,
  providerLimitsLabel,
  USAGE_LIMIT_SOURCE_KIND_LABEL,
} from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SourceAccountDialCard, UsageDialCard } from "./UsageDialCard";

/**
 * The phone's read of every subscription the connected environments can see:
 * the accounts each usage source polls, then the providers signed in on each
 * environment, all drawn as the same dial card the desktop overlay uses.
 *
 * Countdowns anchor to the moment the screen mounted rather than ticking. None
 * of these numbers change a decision inside a minute, and a per-minute clock
 * would re-render every card while agents are running.
 *
 * @module usage/UsageLimitsRouteScreen
 */

const OUTCOME_TEXT: Record<ProviderConsumeResetCreditOutcome, string> = {
  reset: "Reset applied. The windows have cleared.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No reset credit left.",
  alreadyRedeemed: "That credit was already redeemed.",
};

/**
 * Redeems one of a source account's banked credits. Spending is irreversible,
 * so it goes through the native confirm alert rather than firing on a bare
 * tap, and the source's own refusal is shown verbatim rather than reworded.
 */
function SourceResetCredit(props: {
  readonly environmentId: EnvironmentId;
  readonly sourceId: UsageLimitSourceId;
  readonly accountId: string;
  readonly availableCount: number;
}) {
  const consume = useAtomCommand(serverEnvironment.consumeSourceResetCredit, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const redeem = async () => {
    setBusy(true);
    setStatus(null);
    const result = await consume({
      environmentId: props.environmentId,
      input: { sourceId: props.sourceId, accountId: props.accountId },
    });
    setBusy(false);
    setStatus(
      result._tag === "Success"
        ? OUTCOME_TEXT[result.value.outcome]
        : "error" in result.cause && result.cause.error instanceof Error
          ? result.cause.error.message
          : "Could not use the reset credit.",
    );
  };

  const confirm = () => {
    Alert.alert(
      "Use a reset credit?",
      `This redeems one of the ${props.availableCount} credits banked on this account and clears its current rate-limit windows. It cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Use credit", onPress: () => void redeem() },
      ],
    );
  };

  return (
    <View className="gap-2 border-t border-border-subtle pt-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={confirm}
        className="items-center rounded-full bg-subtle-strong px-3 py-2"
      >
        <Text className="text-sm font-t3-medium text-foreground">
          {busy ? "Using credit…" : `Use rate-limit reset credit (${props.availableCount} left)`}
        </Text>
      </Pressable>
      {status ? <Text className="text-sm text-foreground">{status}</Text> : null}
    </View>
  );
}

function SectionHeading(props: { readonly children: string }) {
  return (
    <Text className="px-2 text-xs tracking-wider text-foreground-muted uppercase">
      {props.children}
    </Text>
  );
}

export function UsageLimitsRouteScreen() {
  const insets = useSafeAreaInsets();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const sources = collectLimitSources(presentations);
  const groups = collectLimitsGroups(presentations);
  // Anchored once per mount on purpose: countdowns must not tick.
  const [now] = useState(() => Date.now());
  const isEmpty = sources.length === 0 && groups.length === 0;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 32, gap: 24 }}
    >
      {isEmpty ? (
        <Text className="py-10 text-center text-sm text-foreground-muted">
          No provider or usage source on a connected environment reports subscription limits.
        </Text>
      ) : null}
      {sources.map((source) => (
        <View key={source.key} className="gap-3">
          <SectionHeading>
            {`${source.label} · ${USAGE_LIMIT_SOURCE_KIND_LABEL[source.kind]}`}
          </SectionHeading>
          {source.error ? (
            <Text className="px-2 text-sm text-danger-foreground">{source.error}</Text>
          ) : null}
          {source.accounts.map((account) => (
            <SourceAccountDialCard
              key={account.id}
              account={account}
              now={now}
              footer={
                account.usageLimits.resetCredits &&
                account.usageLimits.resetCredits.availableCount > 0 ? (
                  <SourceResetCredit
                    environmentId={source.environmentId}
                    sourceId={source.id}
                    accountId={account.id}
                    availableCount={account.usageLimits.resetCredits.availableCount}
                  />
                ) : undefined
              }
            />
          ))}
        </View>
      ))}
      {groups.map((group) => (
        <View key={group.environmentId} className="gap-3">
          <SectionHeading>{group.environmentLabel ?? "This machine"}</SectionHeading>
          {group.providers.map((provider) => (
            <UsageDialCard
              key={provider.instanceId}
              driver={provider.driver}
              title={providerLimitsLabel(provider, () => undefined)}
              subtitle={provider.auth.email}
              plan={provider.auth.label}
              windows={provider.usageLimits?.windows ?? []}
              notice={provider.usageLimits ? limitsNotice(provider.usageLimits) : null}
              now={now}
            />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}
