# MCP servers

Settings → MCP Servers lets you add, copy, remove, and authorize servers for your Claude and Codex
accounts. Web, desktop, and mobile show a separate section for each connected machine.

## Adding a server

Enter a name and server URL, select the accounts that should use it, and choose **Add**. For local
commands or custom headers, choose **Use JSON definition**:

```json
{ "command": "npx", "args": ["-y", "some-mcp-server"], "env": { "API_KEY": "..." } }
```

Definitions use Claude's format and are translated for Codex. If an account cannot support a
setting, its result explains why. Failed additions keep your form contents so you can correct
and retry them.

## Managing accounts

Each server lists the accounts that have it, with a separate **Remove** action for each account.
Accounts sharing a configuration directory also share its server list, so removing a server from
one of those accounts affects the others.

**Copy to N more** copies the definition to accounts missing it. Embedded environment variables and
headers stay on the machine. Between Claude accounts, copying includes the complete connector
sign-in, including refresh credentials. Existing complete destination sign-ins are kept. Sign-ins
are not translated between Claude and Codex; authorize the connector in each provider.

## Signing in to a connector

Choose **Manage sign-in** under the account, then **Sign in** and **Open sign-in page**. Approve the
connector in your browser. You can copy the link to another browser if needed.

When connecting remotely or using your phone, the final localhost page may not load. Copy that
page's full address, paste it into the sign-in form, and choose **Complete sign-in**. Leave the
sign-in running until it finishes, or choose **Cancel sign-in** to stop it. Only the client that
started a sign-in can view its link or submit its response.

**Sign out** clears that connector's stored authorization for the account. It does not sign out
your Claude or Codex subscription. Choose **Sign in** again to reconnect.

Claude connector sign-in requires a CLI version with `mcp login --no-browser`. This flow runs
directly and does not require opening a Claude conversation or reaching `/mcp` first.

After changing a connection, start a new conversation to load its tools.

## Understanding status and repairing credentials

Status describes saved credentials, not a live connectivity check:

- **Sign-in stored**: the account has stored authorization.
- **Refresh credentials missing**: Claude has an OAuth record without complete refresh material.
- **Authorization required**: the provider reports that authorization is needed.
- **Not checked**: no OAuth status is available; the server may use an API key or need no sign-in.

For incomplete Claude records, **Repair from default Claude** restores complete credentials from
the same machine's default Claude configuration. It only repairs existing records with the same
server and configuration identifier, preserves the account's subscription sign-in, and clears the
repaired server's cached authorization failure. It leaves complete destination records untouched.

If the default configuration has no matching refresh credentials, use **Sign in** instead. Signing
in independently is also useful if the connector rotates refresh tokens and a shared sign-in stops
working. Credential-store errors appear beside the affected account; **Refresh** reads its status again.

## Scope

Claude plugin connectors with saved authorization or a cached authorization failure appear here
for sign-in and repair. Their definitions remain managed by the plugin, so they have no copy or
remove control here.

Servers are added at the provider's user scope. Repository-specific servers remain managed by the
repository. Cursor, Grok, OpenCode, and Antigravity use their own configuration tools.
