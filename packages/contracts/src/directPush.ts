import * as Schema from "effect/Schema";
import { RelayAgentActivityAggregateState } from "./relay.ts";
import { EnvironmentId } from "./baseSchemas.ts";

const Token = Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]+$/), Schema.isMaxLength(1024));
export const DirectPushRegistration = Schema.Struct({
  deviceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  bundleId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  apsEnvironment: Schema.Literals(["sandbox", "production"]),
  pushToken: Schema.NullOr(Token),
  activityToken: Schema.NullOr(Token),
  notificationsEnabled: Schema.Boolean,
  liveActivitiesEnabled: Schema.Boolean,
});
export type DirectPushRegistration = typeof DirectPushRegistration.Type;

export const DirectPushStatus = Schema.Struct({
  configured: Schema.Boolean,
  bundleId: Schema.NullOr(Schema.String),
  registered: Schema.Boolean,
  activity: RelayAgentActivityAggregateState,
});
export type DirectPushStatus = typeof DirectPushStatus.Type;
export const DirectWidgetUpdate = Schema.Struct({
  environmentId: EnvironmentId,
  activity: RelayAgentActivityAggregateState,
  attentionCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type DirectWidgetUpdate = typeof DirectWidgetUpdate.Type;
