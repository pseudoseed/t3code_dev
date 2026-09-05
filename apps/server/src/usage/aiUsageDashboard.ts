/**
 * Maps an AI usage dashboard's `/api/usage` response onto the usage limit
 * windows the Limits view renders, one row per account it polls.
 *
 * The dashboard groups accounts by company and hands each one a flat list of
 * meters it has already normalised from the vendor's own limits endpoint:
 * `{ id, group, name, percent, resets_at }`, where `group` is exactly the
 * window kinds this contract uses. So the mapping is mostly a rename, plus a
 * driver lookup for the icon and Codex's banked reset credits.
 *
 * Unlike a CLIProxyAPI hub, the dashboard reports accounts this environment
 * is not signed into. An account it could not read keeps its row with the
 * failure on it rather than disappearing, matching how the dashboard's own
 * cards behave.
 *
 * @module usage/aiUsageDashboard
 */
import {
  ProviderDriverKind,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  clampPercent,
  makeUsageLimits,
  makeUnavailableUsageLimits,
} from "../provider/providerUsageLimits.ts";

/**
 * Only the fields the Limits view needs. The dashboard sends much more per
 * poll (sparklines, burn rates, cost lines, an account advisor); decoding a
 * narrow shape keeps a change on its side from failing the whole read.
 */
const DashboardMeter = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  group: Schema.optional(Schema.String),
  percent: Schema.Number,
  resets_at: Schema.optional(Schema.NullOr(Schema.String)),
});

const DashboardAccount = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  label: Schema.optional(Schema.String),
  ok: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  account: Schema.optional(Schema.NullOr(Schema.String)),
  plan: Schema.optional(Schema.NullOr(Schema.String)),
  meters: Schema.optional(Schema.Array(DashboardMeter)),
  reset_credits: Schema.optional(Schema.Number),
  fetched_at: Schema.optional(Schema.String),
  /** Set when the dashboard has parked an account it keeps failing to read. */
  inactive: Schema.optional(Schema.NullOr(Schema.String)),
});
export type DashboardAccount = typeof DashboardAccount.Type;

const DashboardCompany = Schema.Struct({
  key: Schema.String,
  label: Schema.optional(Schema.String),
  accounts: Schema.Array(DashboardAccount),
});

export const AiUsageDashboardStatus = Schema.Struct({
  companies: Schema.Array(DashboardCompany),
});
export type AiUsageDashboardStatus = typeof AiUsageDashboardStatus.Type;
export const decodeAiUsageDashboardStatus = Schema.decodeUnknownEffect(AiUsageDashboardStatus);

/** Reply shape of the dashboard's reset-credit redemption. */
export const AiUsageResetResult = Schema.Struct({
  ok: Schema.optional(Schema.Boolean),
  outcome: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
export const decodeAiUsageResetResult = Schema.decodeUnknownEffect(AiUsageResetResult);

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

const DRIVER_BY_DASHBOARD_PROVIDER: Readonly<Record<string, ProviderDriverKind>> = {
  claude: ProviderDriverKind.make("claudeAgent"),
  codex: ProviderDriverKind.make("codex"),
  gemini: ProviderDriverKind.make("antigravity"),
  xai: ProviderDriverKind.make("grok"),
  grok: ProviderDriverKind.make("grok"),
};

const WINDOW_KINDS = new Set<ServerProviderUsageWindow["kind"]>([
  "session",
  "weekly",
  "monthly",
  "other",
]);

function windowKind(group: string | undefined): ServerProviderUsageWindow["kind"] {
  return group !== undefined && WINDOW_KINDS.has(group as ServerProviderUsageWindow["kind"])
    ? (group as ServerProviderUsageWindow["kind"])
    : "other";
}

const DURATION_BY_KIND: Readonly<Record<ServerProviderUsageWindow["kind"], number | undefined>> = {
  session: SESSION_MINS,
  weekly: WEEK_MINS,
  monthly: MONTH_MINS,
  other: undefined,
};

function isoFromDashboard(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

/**
 * The dashboard names the window for the user (`Session (5h)`,
 * `Weekly (all models)`), so the label is kept verbatim; the bars already
 * carry a duration of their own from `kind`.
 */
export function aiUsageAccountToUsageLimits(
  account: DashboardAccount,
  checkedAt: string,
): ServerProviderUsageLimits {
  const fetchedAt = isoFromDashboard(account.fetched_at) ?? checkedAt;
  const meters = account.meters ?? [];
  if (meters.length === 0) {
    // A parked account can never report until the user revives it on the
    // dashboard, which reads as "unsupported" rather than a failed poll.
    const message =
      account.error?.trim() || (account.inactive ? "Parked by the dashboard." : undefined);
    return makeUnavailableUsageLimits({
      checkedAt: fetchedAt,
      reason: account.inactive ? "unsupported" : "probeFailed",
      ...(message ? { message } : {}),
    });
  }
  const windows: ServerProviderUsageWindow[] = meters.map((meter) => {
    const kind = windowKind(meter.group);
    const duration = DURATION_BY_KIND[kind];
    const resetsAt = isoFromDashboard(meter.resets_at);
    return {
      id: meter.id,
      kind,
      label: meter.name,
      usedPercent: clampPercent(meter.percent),
      ...(duration === undefined ? {} : { windowDurationMins: duration }),
      ...(resetsAt ? { resetsAt } : {}),
    };
  });
  const limits = makeUsageLimits({ checkedAt: fetchedAt, windows });
  const credits = account.reset_credits;
  return credits !== undefined && Number.isFinite(credits) && credits > 0
    ? { ...limits, resetCredits: { availableCount: Math.trunc(credits) } }
    : limits;
}

export function aiUsageStatusToAccounts(
  status: AiUsageDashboardStatus,
  checkedAt: string,
): ReadonlyArray<UsageLimitSourceAccount> {
  const accounts: UsageLimitSourceAccount[] = [];
  for (const company of status.companies) {
    for (const account of company.accounts) {
      const driver = DRIVER_BY_DASHBOARD_PROVIDER[account.provider];
      if (!driver) continue;
      const label = account.label?.trim();
      const email = account.account?.trim();
      const plan = account.plan?.trim();
      accounts.push({
        id: account.id,
        driver,
        ...(label ? { label } : {}),
        ...(email ? { email } : {}),
        ...(plan ? { plan } : {}),
        usageLimits: aiUsageAccountToUsageLimits(account, checkedAt),
      });
    }
  }
  return accounts;
}
