/**
 * MCP server management atoms.
 *
 * A fork-local module rather than entries on the server atoms, so upstream
 * changes to `state/server.ts` merge without touching this.
 */
import {
  WS_METHODS,
  type McpInstanceInventory,
  type McpMutationOutcome,
  type McpServerEntry,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function mcpAuthStatusLabel(status: McpServerEntry["authStatus"]): string {
  switch (status) {
    case "stored":
      return "Sign-in stored";
    case "incomplete":
      return "Refresh credentials missing";
    case "needsAuth":
      return "Authorization required";
    default:
      return "Not checked";
  }
}

export function mcpOutcomeSummary(
  outcomes: ReadonlyArray<McpMutationOutcome>,
  instances: ReadonlyArray<McpInstanceInventory>,
): string {
  return outcomes
    .map(
      (outcome) =>
        `${instances.find((instance) => instance.instanceId === outcome.instanceId)?.displayName ?? outcome.instanceId}: ${outcome.ok ? outcome.message || "Updated" : outcome.message || "Failed"}`,
    )
    .join(" · ");
}

export function createMcpEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    repair: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcpRepair",
      tag: WS_METHODS.mcpRepair,
    }),
    authStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcpAuthStart",
      tag: WS_METHODS.mcpAuthStart,
    }),
    authComplete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcpAuthComplete",
      tag: WS_METHODS.mcpAuthComplete,
    }),
    authCancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcpAuthCancel",
      tag: WS_METHODS.mcpAuthCancel,
    }),
    authLogout: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcpAuthLogout",
      tag: WS_METHODS.mcpAuthLogout,
    }),
    authSubscribe: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:mcpAuthSubscribe",
      tag: WS_METHODS.mcpAuthSubscribe,
      idleTtlMs: 0,
    }),

    // Re-read the native inventory after mutations instead of keeping a second
    // credential/configuration model in the client.
    inventory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:mcp:inventory",
      tag: WS_METHODS.mcpList,
    }),
    add: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp:add",
      tag: WS_METHODS.mcpAdd,
    }),
    copy: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp:copy",
      tag: WS_METHODS.mcpCopy,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp:remove",
      tag: WS_METHODS.mcpRemove,
    }),
  };
}
