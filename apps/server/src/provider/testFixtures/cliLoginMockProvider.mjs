// Stands in for a provider's sign-in command in CliLoginAuth tests.
//
// Both real commands print an authorization URL to stdout and then either wait
// on stdin for a code (Claude) or poll on their own (Codex device auth). This
// reproduces both shapes, including the ANSI coloring the real CLIs emit even
// when stdout is a pipe.
const mode = process.argv[2];

const BLUE = "[94m";
const RESET = "[0m";

if (mode === "code") {
  console.log("Opening browser to sign in…");
  console.log(
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=test-state",
  );
  let buffered = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffered += chunk;
    const newline = buffered.indexOf("\n");
    if (newline < 0) return;
    const code = buffered.slice(0, newline).trim();
    if (code === "good-code") {
      console.log("Login successful");
      process.exit(0);
    }
    console.log("Login failed: Request failed with status code 400");
    process.exit(1);
  });
  // Without this the process exits as soon as stdout drains.
  process.stdin.resume();
} else if (mode === "device") {
  console.log("Follow these steps to sign in with device code authorization:");
  console.log("1. Open this link in your browser");
  console.log(`   ${BLUE}https://auth.openai.com/codex/device${RESET}`);
  console.log("2. Enter this one-time code");
  console.log(`   ${BLUE}ABCD-1234${RESET}`);
  // Stands in for the CLI polling and the user approving in the browser.
  setTimeout(() => process.exit(0), 25);
} else if (mode === "loopback") {
  // Mirrors `codex login`: bind a listener, print the authorize URL whose
  // redirect_uri points back at it, and finish when the browser returns.
  const { createServer } = await import("node:http");
  const port = Number(process.argv[3] ?? 0);
  const state = "loopback-state";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state) {
      res.writeHead(400).end("bad");
      return;
    }
    res.writeHead(200).end("ok");
    setTimeout(() => process.exit(0), 5);
  });
  server.listen(port, "127.0.0.1", () => {
    const bound = server.address().port;
    const redirect = encodeURIComponent(`http://127.0.0.1:${bound}/auth/callback`);
    console.log(`Starting local login server on http://localhost:${bound}.`);
    console.log(
      `https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=${redirect}&state=${state}`,
    );
  });
} else if (mode === "logout") {
  console.log("Removed stored credentials");
  process.exit(0);
} else if (mode === "logout-fail") {
  console.log("Could not reach the credential store");
  process.exit(1);
} else {
  console.log(`unknown mode: ${mode}`);
  process.exit(2);
}
