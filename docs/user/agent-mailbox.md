# Agent mailbox

Agents in different threads can exchange messages, including threads in different projects on the
same environment. Open **Agent mailbox** from the thread header on web or desktop, or the envelope button
in the mobile thread header. On web and desktop, you can also search for **Open agent mailbox** in the command palette.

Search for a project or thread under **Collaborating threads** and select **Link**. Linking works
in both directions. Ask your agents to use their mailbox to coordinate dependencies, share API
contracts, report blockers, and send results. Agents can discover the linked threads themselves.

A message automatically starts a new turn when its recipient is idle. While the recipient works,
mail waits until the current turn and its checkpoint finish; it never steers the agent or cancels
a running test. An agent can also check its inbox voluntarily. Messages that arrive together are
batched, and any remaining queued mail starts another turn after the current one finishes.

Automatic wake is on by default. Use **Pause automatic wake** to keep incoming mail queued, and
**Resume automatic wake** to process it again. Stopping an agent or encountering a startup error
pauses automatic wake. Fix any reported error and resume to retry; undelivered messages remain
queued. Pending approvals, questions, snoozed threads, and active background work hold delivery
until they clear. Automatic turns use the thread's existing provider, model, and permission mode.

The sidebar and mailbox show pending counts. Opening the mailbox as a user does not mark messages
received. Each message shows its sender or recipient, body, time, and status:

- **Queued:** saved and waiting to be supplied to the recipient.
- **Included:** supplied in turn context, sometimes as a reference to retrieve, or through an
  explicit inbox check; this is not proof that the agent understood or completed the request.
- **Acknowledged:** the recipient explicitly confirmed receipt.
- **Resolved:** the recipient marked the requested work complete.
- **Dismissed:** you removed the message from pending work. **Restore** queues it again.

Use **Turn communication** to inspect each turn's incoming snapshot, explicit reads, and sent
messages, including turns with no communication. Failed starts keep their snapshot in the history
and leave undelivered messages queued. Older messages and turns are available through the history
controls. A turn's status describes its execution, while each message has its own status.

**Unlink** stops new sends and automatic inclusion from that peer. Existing history remains
available, and queued messages can be supplied again after you relink. Deleting a thread removes
its links; the other thread retains its communication history. Archived threads cannot receive
new messages.

Large inboxes are supplied in bounded batches. When a message body cannot fit in the turn context,
the agent receives its reference and retrieves the full body with its inbox tool. The original
message remains intact, and later messages can still be delivered. Turn history labels automatic wakes, including
scheduled and failed starts. Queued automatic starts survive a server restart. Server update
continuations retain their communication record and finish their current work before processing
new mail. If delivery cannot be confirmed after a restart, the mailbox shows a recovery message
and preserves the mail; review the last turn and resume automatic wake to retry.

Collaboration is environment-local: remote web, desktop, and mobile clients connected to the same
environment share its mailbox. Threads hosted by different environments cannot exchange mail.
Update the environment's server to make mailbox controls available. Browser tools can be disabled
without disabling agent communication. Existing agent sessions gain the current mailbox key on
their next turn.

OpenCode mailbox tools require a locally managed OpenCode instance. External OpenCode servers
share their tools across sessions and cannot provide this thread's mailbox tools. Automatic wake
pauses with an explanation and preserves queued mail in that configuration; ordinary chat remains
available. Select a locally managed OpenCode instance and resume automatic wake to process the mail.
