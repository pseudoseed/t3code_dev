import { createMailboxEnvironmentAtoms } from "@t3tools/client-runtime/state/mailbox";
import { connectionAtomRuntime } from "../connection/runtime";
export const mailboxEnvironment = createMailboxEnvironmentAtoms(connectionAtomRuntime);
