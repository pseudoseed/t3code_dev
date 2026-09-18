import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import { ZSH_SCRIPTS } from "./scripts.ts";

function prompt(initial: string, render = false) {
  const result = NodeChildProcess.spawnSync("/bin/zsh", ["-f"], {
    input: `PS1=${JSON.stringify(initial)}\n${ZSH_SCRIPTS[".zshrc"]}\nrepeat 100 __t3code_mark_prompt\n${render ? 'print -Pn -- "$PS1"' : 'print -rn -- "$PS1"'}`,
    env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent-t3-prompt-test", TERM: "xterm-256color" },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.replaceAll("\x1b]133;C\x07", "");
}

describe.skipIf(!NodeFS.existsSync("/bin/zsh"))("zsh prompt integration", () => {
  it("separates the stock prompt's directory and input with width-aware colors", () => {
    const value = prompt("%n@%m %1~ %# ");
    expect(value).toBe("\n%F{cyan}%n@%m%f %F{blue}%B%~%b%f\n%F{blue}%#%f %{\x1b]133;B\x07%}");
    const rendered = prompt("%m%# ", true);
    expect(rendered).toContain("\x1b[34m");
    expect(rendered).toContain("\x1b[36m");
    expect(rendered).not.toContain("%F{");
  });

  it("preserves custom prompts and adds exactly one invisible input marker", () => {
    expect(prompt("CUSTOM %~ > ")).toBe("CUSTOM %~ > %{\x1b]133;B\x07%}");
  });
});
