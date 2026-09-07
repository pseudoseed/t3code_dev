# MCP credential management

`ProviderMcpServers` owns environment-local MCP settings operations for Claude and Codex. Clients
use typed environment RPCs, including a session-owned auth subscription; no OAuth tokens are
included in the inventory. Inventory status reflects saved credentials and the provider's cached
authentication failures, not a successful MCP connection.

Claude definitions are copied verbatim through its CLI. For Claude-to-Claude copies,
`ClaudeMcpCredentials` copies whole matching MCP OAuth records, including unknown fields. The
repair action restores incomplete existing records only when the full server/config key matches
the default home's record. Complete destination refresh records and the entire `claudeAiOauth`
account session are preserved. Repair clears only the selected server's needs-auth cache entry,
and only after persisting credentials. There is no background credential synchronization: token
rotation makes continuously sharing refresh credentials unsafe, and independent connector login
is available.

On macOS, the adapter uses `Claude Code-credentials` for the default directory, or a service
suffixed with the first eight hex characters of SHA-256 of the normalized `CLAUDE_CONFIG_DIR`.
It falls back to `.credentials.json` only when the keychain item is absent, never when access is
denied. File writes use a private temporary file and atomic rename. Keychain writes pass the JSON
directly to `security`: its interactive command parser has a 4096-byte line limit. ProcessRunner
reports argument counts rather than argument contents. Persistence is read back before a repair
is reported as successful.

Connector auth reuses `CliLoginAuth` for ownership, expiry, cancellation, and streamed state.
Claude runs `mcp login <name> --no-browser` through `PtyAdapter`: Claude 2.1.261 rejects piped stdin
even with `--no-browser`. `McpPtyLogin` relays bounded output, preserves OSC authorization links,
and sends validated loopback redirects through the PTY. It never opens a browser on the server.
Codex uses its own `mcp login` process and the existing loopback callback forwarder. The CLI owns
PKCE, token exchange, and persistence; T3 checks stored authorization after a successful exit.
Logout runs the corresponding provider's `mcp logout`, without invoking account logout.

A connector authorization does not reload existing agent sessions. Clients tell the user to start
a new conversation after changing a connection. Other provider adapters and project-scoped server
definitions retain their existing management paths.
