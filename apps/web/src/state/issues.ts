import { createIssueEnvironmentAtoms } from "@t3tools/client-runtime/state/issues";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * One set of issue atoms for the app, so the panel and anything else that reads issues share a
 * cache rather than each spending a request on the same list.
 */
export const issueEnvironment = createIssueEnvironmentAtoms(connectionAtomRuntime);
