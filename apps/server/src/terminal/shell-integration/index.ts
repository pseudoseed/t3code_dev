/**
 * Wires OSC 133 shell integration into terminal spawns.
 *
 * The terminal renders whatever the shell sends, and a default zsh or bash
 * prompt sends no styling at all, so prompt, typed input, and command output
 * arrive as one undifferentiated stream. Rather than override the user's
 * prompt, we ask the shell to emit OSC 133 boundary markers; libghostty-vt
 * records them per row and the client draws the separation.
 *
 * Supported for zsh and bash on POSIX platforms. Every other shell spawns
 * untouched.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { BASH_SCRIPT, ZSH_SCRIPTS } from "./scripts.ts";

export type ShellIntegrationKind = "zsh" | "bash";

export interface ShellCandidateLike {
  readonly shell: string;
  readonly args?: ReadonlyArray<string>;
}

export interface ShellIntegrationSpawn {
  /** Mutable to match the pty adapter's spawn input. */
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
}

/** Basename without a Windows extension, matching how shells are named. */
function shellName(shell: string): string {
  const separator = Math.max(shell.lastIndexOf("/"), shell.lastIndexOf("\\"));
  const base = separator === -1 ? shell : shell.slice(separator + 1);
  return base.toLowerCase().replace(/\.exe$/, "");
}

export function shellIntegrationKind(
  shell: string,
  platform: NodeJS.Platform,
): ShellIntegrationKind | null {
  if (platform === "win32") return null;
  const name = shellName(shell);
  if (name === "zsh") return "zsh";
  if (name === "bash") return "bash";
  return null;
}

/**
 * Writes the scripts under `rootDir`, replacing any stale copy. Returns the
 * directory each shell should be pointed at.
 */
export const materializeShellIntegration = Effect.fn("terminal.materializeShellIntegration")(
  function* (rootDir: string, join: (...parts: string[]) => string) {
    const fs = yield* FileSystem.FileSystem;
    const zshDir = join(rootDir, "zsh");
    const bashRc = join(rootDir, "bash-rc");

    yield* fs.makeDirectory(zshDir, { recursive: true });
    for (const [name, contents] of Object.entries(ZSH_SCRIPTS)) {
      yield* fs.writeFileString(join(zshDir, name), contents);
    }
    yield* fs.writeFileString(bashRc, BASH_SCRIPT);

    return { zshDir, bashRc } as const;
  },
);

export interface ShellIntegrationPaths {
  readonly zshDir: string;
  readonly bashRc: string;
}

/**
 * Returns the args and env a candidate should spawn with. Unsupported shells
 * and any spawn whose env already carries our markers are returned unchanged,
 * so a nested T3 Code terminal does not stack integrations.
 */
export function applyShellIntegration(input: {
  readonly candidate: ShellCandidateLike;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly paths: ShellIntegrationPaths;
}): ShellIntegrationSpawn {
  const args = [...(input.candidate.args ?? [])];
  const kind = shellIntegrationKind(input.candidate.shell, input.platform);
  if (kind === null || input.env["T3CODE_SHELL_INTEGRATION"] === "1") {
    return { args, env: input.env };
  }

  if (kind === "zsh") {
    const original = input.env["ZDOTDIR"];
    return {
      args,
      env: {
        ...input.env,
        T3CODE_SHELL_INTEGRATION: "1",
        ZDOTDIR: input.paths.zshDir,
        ...(original === undefined ? {} : { T3CODE_ORIG_ZDOTDIR: original }),
      },
    };
  }

  // `--rcfile` is ignored for a login shell, so the integration is dropped
  // rather than silently doing nothing while also hiding the user's ~/.bashrc.
  if (args.includes("-l") || args.includes("--login")) {
    return { args, env: input.env };
  }
  return {
    args: [...args, "--rcfile", input.paths.bashRc, "-i"],
    env: { ...input.env, T3CODE_SHELL_INTEGRATION: "1" },
  };
}
