/**
 * MCP server management atoms.
 *
 * A fork-local module rather than entries on the server atoms, so upstream
 * changes to `state/server.ts` merge without touching this.
 */
import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export function createMcpEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    // Reading is a single small JSON file per instance, so the list can be
    // re-fetched after every write instead of maintaining a local mirror.
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
