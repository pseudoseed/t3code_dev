import AgentActivity, { type AgentActivityProps } from "../../widgets/pseudocode/OverviewActivity";

export function getAgentLiveActivities() {
  return AgentActivity.getInstances();
}

export function startAgentLiveActivity(props: AgentActivityProps, staleDate?: Date) {
  return AgentActivity.start(props, undefined, staleDate);
}
