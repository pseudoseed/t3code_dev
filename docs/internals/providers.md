# Provider constraints

Orchestration records intent and state without knowing which provider runs a thread. Provider
protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../apps/server/src/provider/Services/ProviderAdapter.ts). Normalize there
instead of spreading provider checks through reactors and clients.

A driver kind identifies an integration; an instance identifies one configuration and account
lifecycle. Route work by instance, so two accounts using the same driver do not share mutable
session or catalog state.

## Process and account isolation

T3-managed OpenCode chat uses one server per thread. Its MCP registrations are directory-scoped, while
T3's MCP connection is thread-scoped. Sharing a chat server between threads in one directory would
let them replace each other's connection. Catalog and text-generation work can share the
[instance-owned helper](../../apps/server/src/provider/OpenCodeServerOwner.ts), which closes
after an idle period. External OpenCode servers remain externally owned and can require an
external restart to pick up configuration changes.

OpenCode also stores persistent approval grants per directory. Automatic full-access replies use
`once` so they cannot widen a supervised thread's permissions on a shared external server.
See the [adapter](../../apps/server/src/provider/Layers/OpenCodeAdapter.ts).

Antigravity separates account profiles per instance while sharing installed executables across the
environment. It forces file-based credential storage because the native macOS keychain entry would
otherwise be shared across instances. The launch environment removes ambient Google credentials,
so an instance cannot silently use another account or billing project. The agent also resolves
its user-global skill directories under that profile, so the profile links those two directories
back to the user's real `~/.gemini`; MCP servers, hooks, and rules there stay out of the profile.
See [profile isolation](../../apps/server/src/provider/antigravityAuthSupport.ts).

The [Antigravity installer](../../apps/server/src/provider/AntigravityInstallation.ts) outlives
client connections and provider-instance rebuilds. Releases are immutable, with an atomic pointer
selecting the version for new processes. Running processes hold leases on their version. Updates
and removal must respect those leases instead of replacing executables under a running agent.

## Setup must not happen as a health-check side effect

Opening a provider session can start MCP servers, run hooks, or launch a login browser.
[Grok probes](../../apps/server/src/provider/Layers/GrokProvider.ts) avoid authentication and
session creation for this reason. Antigravity likewise reserves authenticated catalog sessions for
explicit setup or model refresh; background checks use initialization only.

[Antigravity sign-in](../../apps/server/src/provider/AntigravityAuth.ts) belongs to the initiating
T3 auth session. The client carries the return URL back to the environment because the provider's
loopback listener may be on another machine. Forward only the callback for the owned pending flow;
a successful callback HTTP request is not proof that provider authentication finished. The native
process owns token exchange and storage.

Antigravity sign-out closes admission to new processes and stops existing processes before clearing account
metadata. Otherwise a helper or resumed session could retain the old account. Cached model lists
do not establish current access, and an authoritative empty catalog must clear the old list.

Antigravity text-generation helpers deny tool requests, but native hooks and MCP configuration can
run before the prompt. They reject profiles with such configuration before launch. Prompt
instructions and tool denial do not create a native sandbox.
See [helper constraints](../../apps/server/src/textGeneration/AntigravityTextGeneration.ts).

## Provider updates run only through the owning installer

A one-click update is offered only when the resolved executable's path proves which installer owns
it. Homebrew and npm are proven by the real path (symlinks followed): a versioned keg or cask under
`brew --prefix`, or `<prefix>/lib/node_modules/<pkg>/` (Windows: the shim beside `node_modules`).
Native installer layouts and the global bin directories of pnpm, Bun, and Vite+ may match on either
the resolved path or its real target, since those installers place real files or their own symlinks
there. Anything unproven stays manual-only but still reports the version gap. npm updates pin
`--prefix` because the `npm` on `PATH` can belong to a different Node than the one that owns the
provider. Homebrew
compares against `brew info` since casks trail npm by hours; native installs share npm's version
train, so the registry stays authoritative for them.
See the [resolver](../../apps/server/src/provider/providerMaintenance.ts).

Ownership is cached per instance and re-read immediately before an update runs. The
[runner](../../apps/server/src/provider/providerMaintenanceRunner.ts) refuses when the lock key
changed since the advisory, and reports success only when the refreshed provider is still installed
with a readable, current version.

## Protocol traps

Codex async questions arrive as notifications and are answered with a new user message. There is
no pending RPC response to send. Blocking questions still use the request/response path. The
[adapter](../../apps/server/src/provider/Layers/CodexAdapter.ts) distinguishes them; the
[decider](../../apps/server/src/orchestration/decider.ts) records an async answer and its user
message together.

An async question can outlive the turn or a server restart. The engine reads that request's
durable activity before resolving it because the in-memory command snapshot omits old activities.
Do not infer that a request has disappeared merely because it is outside the recent window.

Capabilities must describe what the provider can actually do. Antigravity can capture workspace
checkpoints but cannot roll back its conversation. The [checkpoint boundary](./overview.md#turn-completion-and-checkpoints)
therefore rejects revert before touching files. Native permission and question option IDs must
also survive normalization; a display label is not necessarily a valid reply.

## Attachments and stored history

Attachments live outside the project workspace. [ProviderService](../../apps/server/src/provider/Layers/ProviderService.ts)
puts their environment-local paths in turn input and lets adapters choose native input formats.
A path in the prompt does not grant filesystem access. Keep provider sandbox and approval rules
in force; copying uploads into the project to bypass them changes that boundary.

File attachments introduced a replay compatibility limit. Image-only clients cannot decode
file-bearing messages, and an image-only server can fail the entire environment's startup when
replaying one such event. Rollouts and downgrades must account for persisted history as well as
current client support.

Model classification has its own [manifest constraints](./model-manifest.md). Assistant-reference
handling is documented under [citations](./assistant-citations.md).

## Claude and Codex sign-in

Claude and Codex sign in by driving each vendor's own login command rather than by reimplementing
their OAuth. T3 Code never holds a client ID, performs a token exchange, or stores an access token;
the CLI does all of that, in its own format, and refreshes on use. Reauthentication after an expiry
or revocation is the same flow run again, which is why there is no separate refresh path.

[`CliLoginAuth`][cli-login-auth] is the shared `ProviderAuthController` for this. It spawns the
login command, reads the authorization URL out of its output, publishes it as flow state, relays the
user's response back, and settles on the process exit code. Per-provider specifics live in
[`ClaudeLogin`][claude-login] and [`CodexLogin`][codex-login]:

| Provider | Command                     | Completion    | Verified with               |
| -------- | --------------------------- | ------------- | --------------------------- |
| Claude   | `claude auth login`         | `code`        | `claude auth status --json` |
| Codex    | `codex login`               | `redirectUrl` | `codex login status`        |
| Codex    | `codex login --device-auth` | `none`        | `codex login status`        |

Claude's flow ends on an Anthropic page that shows a code; the CLI reads that code from stdin, so
`complete` writes it to the child and closes the pipe with `Queue.end`. `Queue.shutdown` would
discard the buffered code, so it is reserved for abandoning a flow.

Codex defaults to its loopback redirect. That mode binds a hardcoded port, so only one Codex sign-in
can run on a machine at a time, and a browser on another device lands on a `localhost` URL it cannot
reach. The user pastes that URL back and [`cliLoginCallback.ts`][cli-login-callback] validates it
against the redirect and state carried in the authorization URL, then delivers it once to the CLI's
listener without probing or following redirects. Delivery succeeding is not authentication
succeeding.

Device authorization is the opt-in fallback behind `CodexSettings.deviceCodeLogin`, not the default,
because OpenAI ships device code authorization **disabled** on ChatGPT accounts: an account that has
not enabled it in ChatGPT security settings is told to go run a terminal command, which is exactly
what this feature exists to avoid. When it is enabled, `complete` is rejected and the `userCode`
field carries what the user types into OpenAI's page.

The flow's `completion` is decided at runtime, not from configuration: `receiveLine` parses the
authorization URL and upgrades a flow to `redirectUrl` when that URL carries a loopback
`redirect_uri`. A CLI that changes modes therefore cannot desync the client.

A zero exit code only means the command ran, so the controller re-reads the CLI's own status before
reporting success. Output parsing is confined to [`cliLoginOutput.ts`][cli-login-output], which
strips ANSI, matches authorization URLs against a per-provider host allowlist, and redacts URLs out
of failure messages so PKCE state cannot reach a client. Only the initiating auth session sees the
URL, code, and flow ID; other clients see busy state.

### Per-instance credentials

A provider CLI keeps one account per credential directory, so
[`providerCredentialHome.ts`][provider-credential-home] gives every instance its own directory under
`ServerConfig.providerHomesDir`. The instance whose id equals its driver kind is the one migrated
from the single-instance world and keeps pointing at the provider's default home, so an existing
sign-in is never disturbed. A path the user configured always wins.

Claude uses this as `CLAUDE_CONFIG_DIR`. Claude Code derives its macOS keychain item name from that
directory, so distinct directories mean distinct keychain entries and a second sign-in cannot
overwrite the first. Codex uses it as `shadowHomePath`, so `auth.json` stays private per instance
while sessions and other state stay shared from `CODEX_HOME` (see
[`CodexHomeLayout`][codex-home-layout]).

The controller also refuses to start while another flow is in progress on the same instance, since
two concurrent logins would race for one credential directory.

### Follow-ups during active work

Ordinary follow-ups use the existing `thread.turn.start` command on every client. Delivery belongs
at the adapter boundary; clients do not interrupt a turn before sending another message.

- Claude adds input to its live SDK prompt queue and retains the active turn id.
- Cursor sends another ACP prompt and retains the turn until all in-flight prompts settle.
- OpenCode submits `session.promptAsync` and retains the active turn through prompt admission.
- Codex serializes send admission and uses [`turn/steer`](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)
  with `expectedTurnId` when the active turn's last submitted model, effort, service tier, and
  interaction mode match. Settings changes use `turn/start`, since steering cannot carry those
  overrides. An explicit missing-method or stale-turn rejection falls back to `turn/start`;
  ambiguous failures and other rejections never resend the input automatically. A steering
  acknowledgement does not change liveness, which remains owned by runtime notifications.
- Grok and Antigravity retain their cancel-before-prompt behavior. They are outside the scope of
  the non-cancelling follow-up path.

`ProviderCommandReactor` records a rejected follow-up as a failure activity without clearing an
already running turn. Provider runtime events report any actual failure or completion of that
work. Stop remains the separate `thread.turn.interrupt` command. This behavior uses the same
server path for web, desktop, mobile, and remote connections.

## Subagent model overrides

`OrchestrationThread.subagentModelSelection` holds the model a thread's subagents run on; null
means inherit. Clients set it with `thread.meta.update` on an existing thread, or carry it on
`thread.turn.start`'s `bootstrap.createThread` when the first message creates the thread (web keeps
it in the composer draft store, mobile in the composer draft and the offline outbox). The decider
rejects a selection whose
`instanceId` differs from the thread's own, then clears a stranded selection when the thread's main
model moves to another instance. Subagents run inside the session's process, so cross-provider
selections are unrunnable by construction.

Adapters translate it at session start, which is the only point either CLI reads it:

- Claude sets `CLAUDE_CODE_SUBAGENT_MODEL` in the query environment to the resolved api model id.
  Unset (or `inherit`) leaves the CLI inheriting the main loop's model. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`
  is deliberately left unset so a `model` on the agent's own Task call still wins.
- Codex sends `config: { subagent_model }` on `thread/start` and `thread/resume`, the same session
  config layer `codex -c` writes.

Neither CLI exposes a control request for changing it on a live session, so
[`ProviderCommandReactor`][cmd] restarts the session when the thread's selection no longer matches
`ProviderSession.subagentModel`, alongside the existing runtime-mode and cwd restart triggers. The
selection is persisted on the session binding so a recovered session opens with the same override.

[cli-login-auth]: ../../apps/server/src/provider/CliLoginAuth.ts
[cli-login-callback]: ../../apps/server/src/provider/cliLoginCallback.ts
[cli-login-output]: ../../apps/server/src/provider/cliLoginOutput.ts
[claude-login]: ../../apps/server/src/provider/Drivers/ClaudeLogin.ts
[codex-login]: ../../apps/server/src/provider/Drivers/CodexLogin.ts
[codex-home-layout]: ../../apps/server/src/provider/Drivers/CodexHomeLayout.ts
[provider-credential-home]: ../../apps/server/src/provider/providerCredentialHome.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
