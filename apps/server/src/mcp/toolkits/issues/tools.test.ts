import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import {
  IssueCommentTool,
  IssueCreateTool,
  IssueListTool,
  IssueReadTool,
  IssueSetStateTool,
  IssueToolkit,
} from "./tools.ts";

describe("issue toolkit", () => {
  it("offers the five things an agent needs to work an issue", () => {
    assert.deepStrictEqual(Object.keys(IssueToolkit.tools).toSorted(), [
      "issue_comment",
      "issue_create",
      "issue_list",
      "issue_read",
      "issue_set_state",
    ]);
  });

  it("marks the reads as readonly so a host can offer them without a prompt", () => {
    for (const tool of [IssueListTool, IssueReadTool]) {
      assert.strictEqual(Context.getUnsafe(tool.annotations, Tool.Readonly), true, tool.name);
    }
  });

  it("marks the writes as neither readonly nor destructive", () => {
    // Posting a comment or opening an issue adds something; none of them destroy anything, and
    // saying they do would train a reader to click through the warning that matters.
    for (const tool of [IssueCommentTool, IssueCreateTool, IssueSetStateTool]) {
      assert.strictEqual(Context.getUnsafe(tool.annotations, Tool.Readonly), false, tool.name);
      assert.strictEqual(Context.getUnsafe(tool.annotations, Tool.Destructive), false, tool.name);
    }
  });

  it("does not ask the agent which project it is in", () => {
    // The thread already names one. A parameter here would only let it name the wrong one.
    for (const tool of [IssueListTool, IssueReadTool, IssueCreateTool]) {
      const keys = Object.keys(tool.parametersSchema.fields ?? {});
      assert.ok(!keys.includes("projectId"), `${tool.name} takes ${keys.join(", ")}`);
      assert.ok(!keys.includes("repository"), `${tool.name} takes ${keys.join(", ")}`);
    }
  });
});
