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
  });
}
