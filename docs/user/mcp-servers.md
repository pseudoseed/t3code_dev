# MCP servers

Settings, MCP lists the MCP servers each of your Claude and Codex accounts loads, and lets you add,
copy, or remove them without opening a terminal. It is on web, desktop, and the phone app.

Every account you sign into keeps its own configuration directory, and Claude and Codex store
servers in different formats. A server added from a terminal only reaches whichever account owns
that directory, which is why running several accounts used to mean repeating the same setup once
per account, per provider. This page does that part for you.

## Seeing what is configured

Each row is one server. The chips underneath it show which accounts have it, labelled with their
provider, and any account without it is greyed out and struck through. A row that lists credentials is telling you the entry
carries an API key or bearer token; the values themselves stay on the machine that runs T3 Code and
are never sent to the app.

## Adding a server

Fill in a name, paste the server definition as JSON, and tick the accounts to apply it to. The JSON
is the same shape Claude Code accepts:

```json
{ "type": "http", "url": "https://mcp.example.com/mcp" }
```

```json
{ "command": "npx", "args": ["-y", "some-mcp-server"], "env": { "API_KEY": "..." } }
```

Write it in Claude's format. Codex accounts get it translated into theirs. Each account is updated
in turn, and the result line tells you which ones succeeded.

A few definitions cannot cross providers. Codex has no place to store arbitrary request headers, so
a remote server carrying them is refused on Codex accounts with a reason, rather than installed
without its credentials and left to fail at connect time.

## Copying a server to your other accounts

When a row is missing from some accounts, it offers **Copy to N more**. This takes the full
definition, credentials included, from an account that already has it and writes it to the rest,
translating between Claude and Codex where needed. Nothing is retyped and no secret leaves the
machine.

## Signing in to a connector

Some servers authorize through a browser instead of an API key. Those sign-ins only work from the
interactive Claude CLI, so the last section gives you a ready-made command for each account. Copy
it, run it in a terminal, and use `/mcp` there.

If an account lists a variable such as `CLAUDE_CODE_OAUTH_TOKEN`, its sign-in lives in T3 Code's
settings rather than on disk. Set that variable in your shell as well, or the CLI starts as a
signed-out account and asks you to log in. Logging in there is a separate sign-in and does not
touch the one T3 Code uses.

`/mcp` typed into a T3 Code conversation does nothing. It is a command the Claude terminal handles
itself, and conversations run Claude without a terminal attached.

## On your phone

Settings, MCP Servers shows the same thing, one block per machine you are connected to. Accounts
and their configuration directories belong to a single machine, so nothing is shared across them.

## What this page does not cover

Claude and Codex accounts appear here. Cursor, Grok, OpenCode, and Antigravity still need their own
configuration files.

Servers are written at each provider's user scope. Per-project servers from a repository's
`.mcp.json` are still loaded by your conversations, but they are managed in the repository, not
here.

Codex keeps sign-ins per account but shares one server list across accounts that share a home
directory, so those accounts always show the same servers.
