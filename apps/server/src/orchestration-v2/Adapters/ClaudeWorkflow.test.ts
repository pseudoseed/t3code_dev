import { describe, expect, it } from "vite-plus/test";

import {
  claudeTaskMetadata,
  parseWorkflowProgress,
  workflowAgentStatus,
  workflowRunHandles,
} from "./ClaudeWorkflow.ts";

describe("Claude workflow progress", () => {
  it("ignores malformed entries, deduplicates slots, and bounds the roster", () => {
    const progress = parseWorkflowProgress([
      null,
      false,
      {},
      { type: "workflow_agent", index: -1, state: "running" },
      { type: "workflow_phase", index: 0, title: "First" },
      { type: "workflow_phase", index: 0, title: "Duplicate" },
      { type: "workflow_agent", index: 0, state: "pending", tokens: -1 },
      { type: "workflow_agent", index: 0, state: "done" },
      ...Array.from({ length: 120 }, (_, index) => ({
        type: "workflow_agent",
        index: index + 1,
        state: "pending",
      })),
      ...Array.from({ length: 80 }, (_, index) => ({
        type: "workflow_phase",
        index: index + 1,
        title: `Phase ${index + 1}`,
      })),
    ]);
    expect(progress?.phases).toHaveLength(64);
    expect(progress?.phases[0]).toEqual({ index: 0, title: "First" });
    expect(progress?.agents).toHaveLength(100);
    expect(progress?.agents[0]).toMatchObject({ index: 0, state: "pending", tokens: undefined });
    expect(progress?.agents.at(-1)?.index).toBe(99);
    expect(parseWorkflowProgress([null, { type: "unrelated" }])).toBeUndefined();
  });

  it("keeps unstarted members pending and reads terminal states", () => {
    const states = ["queued", "running", "unknown", "done", "error"];
    const progress = parseWorkflowProgress(
      states.map((state, index) => ({ type: "workflow_agent", index, state })),
    );
    expect(progress?.agents.map(workflowAgentStatus)).toEqual([
      "pending",
      "pending",
      "pending",
      "completed",
      "failed",
    ]);
    expect(
      workflowAgentStatus({ ...progress!.agents[2]!, startedAt: "2026-10-07T12:00:00Z" }),
    ).toBe("running");
  });

  it("infers workflow metadata from progress while keeping native task metrics", () => {
    expect(
      claudeTaskMetadata({
        workflow_progress: [{ type: "workflow_agent", index: 2, state: "running" }],
        subagent_type: "research",
        last_tool_name: "Read",
        output_file: "/tmp/output",
        usage: { total_tokens: 200, tool_uses: 3, duration_ms: 1500 },
      }),
    ).toEqual({
      taskType: "local_workflow",
      role: "research",
      lastToolName: "Read",
      outputFile: "/tmp/output",
      usage: { totalTokens: 200, toolUses: 3, durationMs: 1500 },
    });
    expect(claudeTaskMetadata({ usage: { total_tokens: NaN, tool_uses: -1 } })).toEqual({});
  });

  it("keeps run handles but rejects non-web session links", () => {
    expect(
      workflowRunHandles({
        taskId: " task ",
        runId: " run ",
        scriptPath: "/tmp/run.js",
        sessionUrl: "javascript:alert(1)",
      }),
    ).toEqual({
      taskId: "task",
      handles: { runId: "run", scriptPath: "/tmp/run.js" },
    });
    expect(
      workflowRunHandles({ taskId: "task", sessionUrl: "https://example.com/workflow" })?.handles
        .sessionUrl,
    ).toBe("https://example.com/workflow");
    expect(workflowRunHandles({ taskId: "task", sessionUrl: "not a url" })).toBeUndefined();
  });
});
