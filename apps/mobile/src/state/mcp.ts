import { createMcpEnvironmentAtoms } from "@t3tools/client-runtime/state/mcp";

import { connectionAtomRuntime } from "../connection/runtime";

/** MCP server management, scoped to the environment that owns the CLI configs. */
export const mcpEnvironment = createMcpEnvironmentAtoms(connectionAtomRuntime);
