import { describe, expect, it } from "vite-plus/test";

import { applyShellIntegration, shellIntegrationKind } from "./index.ts";

const paths = {
  zshDir: "/state/shell-integration/zsh",
  bashRc: "/state/shell-integration/bash-rc",
};

function apply(shell: string, env: NodeJS.ProcessEnv, args?: string[]) {
  return applyShellIntegration({
    candidate: args ? { shell, args } : { shell },
    env,
    platform: "darwin",
    paths,
  });
}

describe("shellIntegrationKind", () => {
  it("recognizes zsh and bash by path, and nothing else", () => {
    expect(shellIntegrationKind("/bin/zsh", "darwin")).toBe("zsh");
    expect(shellIntegrationKind("/opt/homebrew/bin/bash", "linux")).toBe("bash");
    expect(shellIntegrationKind("/usr/bin/fish", "darwin")).toBeNull();
    expect(shellIntegrationKind("/bin/sh", "darwin")).toBeNull();
  });

  it("never applies on Windows, where the rc mechanisms do not exist", () => {
    expect(shellIntegrationKind("C:\\Program Files\\Git\\bin\\bash.exe", "win32")).toBeNull();
  });
});

describe("applyShellIntegration", () => {
  it("redirects zsh through the shim directory and preserves the user's ZDOTDIR", () => {
    const result = apply("/bin/zsh", { ZDOTDIR: "/home/me/.config/zsh", PATH: "/usr/bin" }, [
      "-o",
      "nopromptsp",
    ]);
    expect(result.env["ZDOTDIR"]).toBe(paths.zshDir);
    expect(result.env["T3CODE_ORIG_ZDOTDIR"]).toBe("/home/me/.config/zsh");
    // The shim reads the user's real files; losing PATH would break the shell.
    expect(result.env["PATH"]).toBe("/usr/bin");
    expect(result.args).toEqual(["-o", "nopromptsp"]);
  });

  it("omits the original ZDOTDIR when the user never set one", () => {
    const result = apply("/bin/zsh", {});
    expect(result.env["ZDOTDIR"]).toBe(paths.zshDir);
    expect("T3CODE_ORIG_ZDOTDIR" in result.env).toBe(false);
  });

  it("points bash at the generated rc without dropping existing args", () => {
    const result = apply("/bin/bash", {}, ["--norc"]);
    expect(result.args).toEqual(["--norc", "--rcfile", paths.bashRc, "-i"]);
    expect(result.env["T3CODE_SHELL_INTEGRATION"]).toBe("1");
  });

  it("leaves a bash login shell alone, since --rcfile would be ignored", () => {
    // Applying it anyway would hide ~/.bashrc while delivering no markers.
    const result = apply("/bin/bash", {}, ["-l"]);
    expect(result.args).toEqual(["-l"]);
    expect("T3CODE_SHELL_INTEGRATION" in result.env).toBe(false);
  });

  it("leaves unsupported shells untouched", () => {
    const result = apply("/usr/bin/fish", { ZDOTDIR: "/home/me" });
    expect(result.env["ZDOTDIR"]).toBe("/home/me");
    expect(result.args).toEqual([]);
  });

  it("does not stack when a T3 Code terminal spawns another shell", () => {
    const result = apply("/bin/zsh", {
      T3CODE_SHELL_INTEGRATION: "1",
      ZDOTDIR: "/state/shell-integration/zsh",
      T3CODE_ORIG_ZDOTDIR: "/home/me",
    });
    expect(result.env["T3CODE_ORIG_ZDOTDIR"]).toBe("/home/me");
  });
});
