import { carryProjectIcons, reconcileOverviewSnapshot } from "./pseudocode/overviewSnapshot";
import * as Linking from "expo-linking";
import type { DirectWidgetUpdate } from "@t3tools/contracts";
import { mergeWidgetUpdate, type AgentWidgetSnapshot } from "./agentWidgetSnapshot";

let pending: Promise<void> = Promise.resolve();
function write(operation: () => Promise<void>) {
  const result = pending.then(operation);
  pending = result.catch(() => undefined);
  return result;
}
export function saveWidgetSnapshot(snapshot: AgentWidgetSnapshot) {
  return write(async () => {
    const { default: widget } = await import("./AgentWidget");
    widget.updateSnapshot(snapshot);
    const { default: overview } = await import("./pseudocode/OverviewWidget");
    const previous = (await overview.getTimeline()).at(0)?.props;
    updateOverview(overview, reconcileOverviewSnapshot(snapshot, previous), previous);
  });
}
export function saveWidgetPush(update: DirectWidgetUpdate) {
  return write(async () => {
    const { default: widget } = await import("./AgentWidget");
    const timeline = await widget.getTimeline();
    const current = timeline.at(-1)?.props;
    if (!current) return;
    const next = mergeWidgetUpdate(current, update);
    if (next !== current) widget.updateSnapshot(next);
    const { default: overview } = await import("./pseudocode/OverviewWidget");
    const overviewCurrent = (await overview.getTimeline()).at(0)?.props ?? current;
    const overviewNext = mergeWidgetUpdate(overviewCurrent, update);
    if (overviewNext !== overviewCurrent) updateOverview(overview, overviewNext, overviewCurrent);
  });
}

function updateOverview(
  widget: import("expo-widgets").Widget<AgentWidgetSnapshot>,
  snapshot: AgentWidgetSnapshot,
  previous: AgentWidgetSnapshot | undefined,
) {
  const now = new Date();
  const props = {
    ...carryProjectIcons(snapshot, previous),
    appScheme: Linking.createURL("/").split(":")[0],
    updatedAt: snapshot.updatedAt ?? now.toISOString(),
  };
  widget.updateTimeline([
    { date: now, props },
    {
      date: new Date(Math.max(now.getTime(), Date.parse(props.updatedAt)) + 25 * 60_000 + 1),
      props,
    },
  ]);
}
