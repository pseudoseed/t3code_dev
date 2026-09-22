import type { LiveActivity } from "expo-widgets";
import type { AgentActivityProps } from "../../widgets/pseudocode/OverviewActivity";

export function getAgentLiveActivities(): Array<LiveActivity<AgentActivityProps>> {
  return [];
}

export function startAgentLiveActivity(
  _props: AgentActivityProps,
): LiveActivity<AgentActivityProps> | null {
  return null;
}
