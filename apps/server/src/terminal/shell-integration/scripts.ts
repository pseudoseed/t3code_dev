/**
 * Shell integration scripts, embedded as strings.
 *
 * They are written to disk at spawn time rather than shipped as files because
 * the server runs bundled (and inside an Electron asar), where a
 * source-relative path does not survive packaging.
 *
 * Each script sources the user's real configuration first and only then emits
 * OSC 133 markers, so a terminal session behaves exactly as it would outside
 * T3 Code. The markers let the client tell prompt, typed input, and command
 * output apart; libghostty-vt parses them natively.
 */

/**
 * zsh reads `.zshenv`, `.zprofile`, `.zshrc`, and `.zlogin` from `ZDOTDIR`, so
 * pointing `ZDOTDIR` at our directory would hide all four from the user. Each
 * shim restores the original directory, sources the matching real file, and
 * puts our directory back for the next stage.
 */
const zshShim = (file: string) => `# T3 Code shell integration shim. Generated; do not edit.
if [[ -f "\${T3CODE_ORIG_ZDOTDIR:-$HOME}/${file}" ]]; then
  __t3code_zdotdir=$ZDOTDIR
  ZDOTDIR="\${T3CODE_ORIG_ZDOTDIR:-$HOME}"
  builtin source "\${T3CODE_ORIG_ZDOTDIR:-$HOME}/${file}"
  ZDOTDIR=$__t3code_zdotdir
  builtin unset __t3code_zdotdir
fi
`;

const ZSH_MARKERS = `
# --- T3 Code OSC 133 markers ---
# A: prompt start, B: prompt end (input starts), C: input end (output starts),
# D: command finished, carrying the exit status.
if [[ -z "\${__t3code_integration_loaded:-}" ]]; then
  __t3code_integration_loaded=1
  builtin autoload -Uz add-zsh-hook

  __t3code_prompt_marker=$'%{\\033]133;B\\007%}'

  __t3code_mark_prompt() {
    # Prompt frameworks (starship, powerlevel10k) rebuild PS1 on every precmd.
    # Re-appending keeps the input marker present without owning the prompt.
    if [[ "$PS1" != *"\\033]133;B"* ]]; then
      PS1="\${PS1}\${__t3code_prompt_marker}"
    fi
  }

  __t3code_precmd() {
    # status is a zsh synonym for the exit code, so it needs its own name.
    local __t3code_exit=$?
    if [[ -n "\${__t3code_command_running:-}" ]]; then
      builtin printf '\\033]133;D;%s\\007' "$__t3code_exit"
      builtin unset __t3code_command_running
    fi
    __t3code_mark_prompt
    builtin printf '\\033]133;A\\007'
  }

  __t3code_preexec() {
    __t3code_command_running=1
    builtin printf '\\033]133;C\\007'
  }

  add-zsh-hook precmd __t3code_precmd
  add-zsh-hook preexec __t3code_preexec
fi
`;

/**
 * `.zshrc` additionally restores `ZDOTDIR` to the user's own value so anything
 * the user runs later sees the environment it expects, then installs markers.
 */
export const ZSH_SCRIPTS: Readonly<Record<string, string>> = {
  ".zshenv": zshShim(".zshenv"),
  ".zprofile": zshShim(".zprofile"),
  ".zlogin": zshShim(".zlogin"),
  ".zshrc": `${zshShim(".zshrc")}
if [[ -n "\${T3CODE_ORIG_ZDOTDIR:-}" ]]; then
  ZDOTDIR=$T3CODE_ORIG_ZDOTDIR
else
  builtin unset ZDOTDIR
fi
builtin unset T3CODE_ORIG_ZDOTDIR
${ZSH_MARKERS}`,
};

/**
 * bash makes this simpler than zsh: PS0 is printed after the command is read
 * but before it runs, which is exactly the output-start boundary, and PS1 can
 * carry the rest. `--rcfile` replaces `~/.bashrc`, so we source it ourselves.
 */
export const BASH_SCRIPT = `# T3 Code shell integration. Generated; do not edit.
if [[ -f "\${T3CODE_ORIG_BASHRC:-$HOME/.bashrc}" ]]; then
  source "\${T3CODE_ORIG_BASHRC:-$HOME/.bashrc}"
fi
unset T3CODE_ORIG_BASHRC

if [[ -z "\${__t3code_integration_loaded:-}" ]]; then
  __t3code_integration_loaded=1

  __t3code_first_prompt=1

  __t3code_precmd() {
    local __t3code_exit=$?
    # The very first prompt has no command behind it to report.
    if [[ -z "\${__t3code_first_prompt:-}" ]]; then
      printf '\\033]133;D;%s\\007' "$__t3code_exit"
    fi
    __t3code_first_prompt=
    __t3code_in_command=
    printf '\\033]133;A\\007'
  }

  if [[ \${BASH_VERSINFO[0]} -gt 4 || ( \${BASH_VERSINFO[0]} -eq 4 && \${BASH_VERSINFO[1]} -ge 4 ) ]]; then
    # PS0 is emitted once per command, between reading it and running it.
    PS0='\\[\\033]133;C\\007\\]'"\${PS0:-}"
  else
    # bash before 4.4 has no PS0, and macOS still ships 3.2, so the
    # output boundary comes from a DEBUG trap instead. The flag keeps a
    # pipeline from reporting once per stage.
    __t3code_debug() {
      if [[ -n "\${COMP_LINE:-}" ]]; then return 0; fi
      if [[ "\${BASH_COMMAND:-}" == __t3code_precmd* ]]; then return 0; fi
      if [[ -z "\${__t3code_in_command:-}" ]]; then
        __t3code_in_command=1
        printf '\\033]133;C\\007'
      fi
      return 0
    }
    trap '__t3code_debug' DEBUG
  fi
  PS1="\${PS1}"'\\[\\033]133;B\\007\\]'
  PROMPT_COMMAND="__t3code_precmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
`;
