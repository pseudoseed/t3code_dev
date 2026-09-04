/**
 * Parsers for the sign-in output of a provider's own CLI.
 *
 * `CliLoginAuth` drives `claude auth login` / `codex login --device-auth` and
 * has to lift two things out of their terminal output: the authorization URL
 * to hand the user, and (for device authorization) the one-time code they type
 * into the provider's page. Everything here is pure so the brittle part of the
 * integration is covered by tests instead of by a live sign-in.
 *
 * Host allowlisting is a deliberate control, not defensiveness about our own
 * subprocess: it keeps a hijacked binary or a localized/patched build from
 * getting T3 Code to present an arbitrary link as the provider's login page.
 *
 * @module provider/cliLoginOutput
 */

// Matches CSI and OSC escape sequences. Both CLIs colorize their sign-in
// output even when stdout is a pipe, so the payload lines arrive wrapped in
// these. The control characters are the thing being matched, hence the
// disable rather than a rewrite.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Trailing punctuation a CLI may place after a URL in prose. */
const URL_TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

const URL_PATTERN = /https:\/\/[^\s<>"'`]+/g;

function hostIsAllowed(host: string, allowedHosts: ReadonlyArray<string>): boolean {
  const normalized = host.toLowerCase();
  return allowedHosts.some(
    (allowed) => normalized === allowed || normalized.endsWith(`.${allowed}`),
  );
}

/**
 * First https URL on the line whose host is one of `allowedHosts` (or a
 * subdomain of one). Returns undefined when the line carries no such URL,
 * which is the common case — most output lines are prose.
 */
export function findAuthorizationUrl(
  line: string,
  allowedHosts: ReadonlyArray<string>,
): string | undefined {
  for (const match of stripAnsi(line).matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(URL_TRAILING_PUNCTUATION, "");
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    if (parsed.protocol === "https:" && hostIsAllowed(parsed.hostname, allowedHosts)) {
      return candidate;
    }
  }
  return undefined;
}

// A device code stands alone on its line, so anchoring beats matching the
// surrounding prose: the prose is localized and reworded across releases, the
// code shape is fixed by the provider's verification page.
const DEVICE_CODE_PATTERN = /^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/;

/** The one-time code from a device-authorization prompt, if this line is one. */
export function findDeviceUserCode(line: string): string | undefined {
  const candidate = stripAnsi(line).trim();
  return DEVICE_CODE_PATTERN.test(candidate) ? candidate : undefined;
}

/**
 * Reduce CLI output to something safe to show a user after a failure.
 *
 * Sign-in output interleaves authorization URLs (which carry PKCE state) with
 * ordinary diagnostics. Redacting every URL means a failure message can be
 * surfaced verbatim without leaking one, and dropping empty and decorative
 * lines keeps the last *useful* line rather than a box-drawing character.
 */
export function summarizeCliFailure(output: string, maxLength = 200): string | undefined {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.replace(URL_PATTERN, "[link]").trim())
    .filter((line) => line.length > 0 && /[a-z0-9]/i.test(line));
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  return last.length > maxLength ? `${last.slice(0, maxLength - 1)}…` : last;
}
