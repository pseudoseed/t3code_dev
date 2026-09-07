# Agent mailbox

The mailbox is an environment-local transport between explicitly linked threads. Sends commit
messages before scheduling. The provider reactor admits a new turn only when the recipient is idle;
active turns and tests are never steered, interrupted, or cancelled by mail. Scheduling is event
driven, with one recovery scan after server activation and a cancellable timer for each snoozed
thread with queued mail. There is no polling loop or cross-environment broker.

## Storage and attribution

`packages/contracts/src/mailbox.ts` defines the shared schemas. `thread.mailbox` is an internal
command, excluded from client orchestration commands. Clients use the narrower `mailbox.get` and
`mailbox.update` RPCs; agents use the authenticated MCP toolkit. The engine serializes mailbox
decisions with turn admission and commits canonical `thread.mailbox-updated` events, both threads'
activity records, projections, and the command receipt in one SQL transaction. A multi-thread
command's receipt belongs to the command's originating aggregate.

`MailboxRepository` owns durable validation and SQL queries. Migration 050 adds symmetric links,
immutable message identity/body/provenance, execution receipts, and explicit read receipts. The
`projection.mailbox` projector rebuilds these tables from the event log. Message bodies are only
queried when needed; shell subscriptions carry pending counts and revision numbers. Message and
turn history pages contain at most 30 entries, with stable cursors. Clients use the existing
environment RPC connection for local, remote, relay, and tunnel access.

Thread activity transports retain each communication summary and turn association, but omit the
duplicate mailbox payload. Full message context and execution details remain in the event store
and paged mailbox history, including turns with no messages. Snapshot consistency waits for the
mailbox projector alongside the other read-model projectors. Shell rows omit zero pending counts;
the revision field remains present so clients can discover mailbox support and refresh cleared inboxes.

MCP credentials bind an invocation to its environment, thread, and provider session. A server-issued
turn key further binds it to the current execution. The engine revalidates that identity when a
mutation reaches the command queue; checking only before enqueueing would permit a stale-key race.
Agents cannot link threads or choose a sender identity. `mailbox_send` deduplicates a stable retry
key scoped to the sending thread and rejects reuse with different payload or execution. Messages
can reply only to mail from the chosen recipient. Only recipients acknowledge, resolve, or dismiss;
only user RPCs can restore dismissed messages. Resolved messages are terminal. Queue and snapshot event sequences ensure a late receipt from an older turn cannot consume a restored message.

## Automatic wake

Migration 051 adds per-thread automatic-wake controls and mailbox turn origins. A `wake` operation
runs through the serialized command queue and checks durable pending/running turns, checkpoint
completion, session state, pending approvals/questions, links, archive and snooze state. The engine
also checks background liveness. It atomically records a pending mailbox execution, a visible
automatic-turn message, and a normal turn-start intent. Concurrent arrivals cannot admit another
turn while that execution is pending. Conditional wake commands may commit an accepted receipt
without new events when eligibility changed while they were queued.

The provider reactor uses the normal provider/model/permission path. It rechecks ownership and
pause state after asynchronous session startup, freezes the bounded mailbox snapshot, and then
dispatches. A newer user turn supersedes a pending automatic start. No input is sent if the
mailbox credential is missing or the queued messages were withdrawn before preparation. Completed
turns and checkpoints trigger delivery of the next queued batch. Explicit reads consume queued
messages without triggering a wake.

User stop/interrupt and provider errors pause automatic wake durably. The mailbox shows why and
provides pause/resume controls on web/desktop and mobile. Resume retries preserved mail; failures
do not create an automatic retry loop. Settle-only session cleanup preserves automatic wake.
Pending wake executions are recovered using the same execution/message ID after activation;
active sessions and uncompleted user starts retain priority. An unconfirmed prepared delivery from
a lost provider session pauses automatic wake with a visible recovery explanation. Resume retries
the preserved messages after the user reviews the last turn. Snooze timers use the persisted
deadline, are replaced when the deadline changes, and are rebuilt after activation.

## Turn admission and recovery

`ProviderCommandReactor` prepares an immutable inbox snapshot immediately before provider dispatch.
The user-message ID identifies that execution, separately from the provider's eventual turn ID.
Preparation includes at most eight linked queued messages, in stable oldest-first order, within a
32,000-character envelope and the provider's remaining input budget. Messages are JSON encoded and
attributed as peer context. A shared encoder bounds both snapshot selection and the dispatched JSON.
Bodies that do not fit are represented by immutable message IDs, sender/reply attribution and a
`bodyAvailableVia: "mailbox_read"` marker. The agent must retrieve those bodies before acting;
explicit reads remain separately recorded. This preserves previously accepted messages even when
JSON escaping expands their bodies beyond the context budget. An active turn receives no new inbox snapshot when the user steers it.
A voluntary `mailbox_read` records exactly which incoming IDs were returned during that execution.
Previous unresolved messages are counted in subsequent turn context and remain readable.

Preparation does not consume queued mail. A running session event or successful dispatch binds the
provider turn ID and marks the frozen IDs included. Dispatch failure leaves undelivered messages
queued. Session completion updates submitted receipts; a late dispatch receipt cannot regress a
completed receipt. Recording a successful dispatch failing must only log an error, never route
through provider recovery or interrupt the running work. Each dispatched agent turn has a receipt,
including empty inbox/outbox turns and failed dispatches. Local commands such as context compaction
are not agent message turns.

After a server update, continuation dispatch gets a fresh execution and key but no incoming mail.
Persisted prepared receipts from an older provider session do not suppress a new session's inbox.
If the server dies between dispatch and a delivery receipt, the prepared record remains visible and
mail can be offered again. Delivery is at least once in that uncertain window; consumers should
acknowledge/resolve using message IDs rather than assume exactly-once processing.

## Providers and clients

Codex, Claude, Cursor, Grok, OpenCode, and Antigravity consume the existing T3 MCP session
configuration. `mailbox` is an independent capability issued even when browser tools are disabled;
preview handlers still require their preview capability. Codex's browser instructions follow that
separate preview flag. Existing sessions receive the new turn key on their next dispatched turn.
Trusted provider-turn activity can renew an expired MCP credential retained by its exact live
session; expired bearer traffic alone cannot renew it, and revocation remains authoritative.

Adapters may declare `agentMcp: false`. External OpenCode does so because its MCP clients are shared
by directory rather than session. The provider service withholds/revokes credentials in this mode,
ordinary turns still receive empty communication receipts, and automatic admission pauses with an
actionable explanation before starting a provider or consuming mail. Managed OpenCode requires a
confirmed connected MCP response before accepting its first prompt.

The shared client-runtime atom family supplies web/desktop and mobile. Each client fetches bodies
only while its mailbox is open and refreshes on shell revision changes. Header controls, sidebar
counts, and web/desktop command-palette access expose the same environment-local state. A missing
optional shell revision hides controls when connected to an older server.

## Verification

`AgentMailbox.test.ts` uses file-backed SQLite, the real event engine/projector, and the MCP toolkit.
It exercises atomic wake admission, restart recovery, pause/resume, user-turn priority, authenticated attribution, retry conflicts, cross-thread command receipts, transaction
rollback, event replay and database reopen, concurrent admission/send, input budgets, history
pagination, link/unlink, dismissal/restore, and stale turn keys.

`ProviderCommandReactor.test.ts` runs a real Node test worker behind IPC receipts while the actual
reactor is processing a recipient turn. A message commits during that test, the frozen snapshot
stays unchanged, and no extra provider send/stop/interrupt occurs while the test runs. After the test
and checkpoint finish, queued mail starts a new turn. Additional reactor tests cover bounded batches,
startup failure/retry, pause during startup, and activation-gated recovery of an admitted turn.
The test synchronizes on worker and engine receipts rather than sleeps. Provider-service and MCP
registry tests cover mailbox capability issuance independently of browser settings; startup tests
cover continuation records and preservation of queued mail.

Codev's mailbox was reviewed as prior art. This implementation uses T3's event log and typed RPC/MCP
boundaries; it does not copy Codev code or introduce a dependency on its terminal transport.
