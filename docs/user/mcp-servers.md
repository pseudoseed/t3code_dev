# MCP servers

Settings, MCP lists the MCP servers each of your Claude accounts loads, and lets you add, copy, or
remove them without opening a terminal. It is on web, desktop, and the phone app.

Every Claude account you sign into keeps its own configuration directory. A server added from a
terminal only reaches whichever account owns that directory, which is why running several accounts
used to mean repeating the same setup once per account. This page does that part for you.

## Seeing what is configured

Each row is one server. The chips underneath it show which accounts have it, and any account
without it is greyed out and struck through. A row that lists credentials is telling you the entry
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

Each account is updated in turn, and the result line tells you which ones succeeded.

## Copying a server to your other accounts

When a row is missing from some accounts, it offers **Copy to N more**. This takes the full
definition, credentials included, from an account that already has it and writes it to the rest.
Nothing is retyped and no secret leaves the machine.

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

Only Claude accounts appear here. Codex and the other providers still need their own configuration
files.

Servers are written at Claude's user scope. Per-project servers from a repository's `.mcp.json` are
still loaded by your conversations, but they are managed in the repository, not here.
