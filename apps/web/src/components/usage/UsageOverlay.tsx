import type {
  EnvironmentId,
  ProviderConsumeResetCreditOutcome,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  collectLimitSources,
  collectLimitsGroups,
  limitsNotice,
  providerLimitsLabel,
} from "@t3tools/shared/usageLimits";
import { RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { getDriverOption } from "../settings/providerDriverMeta";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SourceAccountDialCard, UsageDialCard } from "./UsageDialCard";

/**
 * A dismissible read of every subscription this machine can see: the
 * accounts each configured usage source polls, plus the providers signed in
 * on connected environments. It is a glance before starting work, so it opens
 * over whatever the user was doing instead of navigating away from it.
 *
 * Countdowns anchor to the moment the overlay opened rather than ticking. A
 * clock that repaints every minute is a continuous repaint on a view users
 * leave open beside running agents, and none of these numbers change a
 * decision inside a minute.
 *
 * @module usage/UsageOverlay
 */

const OUTCOME_TEXT: Record<ProviderConsumeResetCreditOutcome, string> = {
  reset: "Reset applied. The windows have cleared.",
  nothingToReset: "Nothing to reset right now.",
  noCredit: "No reset credit left.",
  alreadyRedeemed: "That credit was already redeemed.",
};

/**
 * Redeems one of a source account's banked credits. Spending is irreversible,
 * so it never fires on a bare click and the source's own refusal (its
 * cooldown, an empty balance) is shown verbatim rather than reworded.
 */
function SourceResetCredit({
  environmentId,
  sourceId,
  accountId,
  availableCount,
}: {
  readonly environmentId: EnvironmentId;
  readonly sourceId: UsageLimitSourceId;
  readonly accountId: string;
  readonly availableCount: number;
}) {
  const consume = useAtomCommand(serverEnvironment.consumeSourceResetCredit, {
    reportFailure: false,
  });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const redeem = async () => {
    setConfirming(false);
    setBusy(true);
    setStatus(null);
    const result = await consume({
      environmentId,
      input: { sourceId, accountId },
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

  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => setConfirming(true)}
        className="w-full"
      >
        <RotateCcwIcon className="size-3.5" aria-hidden />
        {busy ? "Using credit…" : `Use rate-limit reset credit (${availableCount} left)`}
      </Button>
      {status ? <span className="text-xs text-muted-foreground">{status}</span> : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Use a reset credit?</AlertDialogTitle>
            <AlertDialogDescription>
              This redeems one of the {availableCount} credits banked on this account and clears its
              current rate-limit windows. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button onClick={() => void redeem()}>Use credit</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/**
 * Mounted only while the overlay is open, and remounted by `key` on refresh.
 * That is what anchors `now`: every countdown on screen is measured from the
 * moment this body appeared, so the numbers agree with each other and none of
 * them tick.
 */
function UsageOverlayBody({ onRefreshed }: { readonly onRefreshed: () => void }) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const sources = collectLimitSources(presentations);
  const groups = collectLimitsGroups(presentations);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [now] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all(
      groups.map((group) => refreshProviders({ environmentId: group.environmentId, input: {} })),
    );
    setRefreshing(false);
    onRefreshed();
  };

  const isEmpty = sources.length === 0 && groups.length === 0;

  return (
    <>
      <DialogPanel className="max-h-[70vh] overflow-y-auto">
        {isEmpty ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No provider or usage source on a connected environment reports subscription limits. Add
            one under Usage → Limits.
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {sources.map((source) => (
              <div key={source.key} className="flex flex-col gap-3">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-xs tracking-wide text-muted-foreground uppercase">
                    {source.label}
                  </h2>
                  {source.error ? <span className="text-xs text-error">{source.error}</span> : null}
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
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
                        ) : null
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
            {groups.map((group) => (
              <div key={group.environmentId} className="flex flex-col gap-3">
                <h2 className="text-xs tracking-wide text-muted-foreground uppercase">
                  {group.environmentLabel ?? "This machine"}
                </h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  {group.providers.map((provider) => (
                    <UsageDialCard
                      key={provider.instanceId}
                      driver={provider.driver}
                      title={providerLimitsLabel(
                        provider,
                        (driver) => getDriverOption(driver)?.label,
                      )}
                      plan={provider.auth.label}
                      subtitle={provider.auth.email}
                      windows={provider.usageLimits?.windows ?? []}
                      notice={provider.usageLimits ? limitsNotice(provider.usageLimits) : null}
                      now={now}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogPanel>
      <div className="flex justify-end px-4 pb-4">
        <Button size="sm" variant="ghost" disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCwIcon className="size-3.5" aria-hidden />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
    </>
  );
}

export function UsageOverlay({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [generation, setGeneration] = useState(0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Usage</DialogTitle>
          <DialogDescription>
            Live subscription limits for every account this machine can read.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <UsageOverlayBody
            key={generation}
            onRefreshed={() => setGeneration((value) => value + 1)}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
