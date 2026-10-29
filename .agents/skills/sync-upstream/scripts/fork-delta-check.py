#!/usr/bin/env python3
"""List fork changes an upstream merge dropped.

The fork's changes are the lines fork main added on top of the last upstream commit it merged.
Each one is looked up in the merge result, ignoring whitespace so upstream's reformatting is not
reported. Missing lines are sorted into two groups:

  DROPPED   nothing upstream did explains the loss. Restore it, or say in the PR why not.
  REWRITTEN upstream rewrote or deleted the code the fork had changed. Check the fork's intent
            survived in the new code; often it did, in different words.

Lines upstream itself added and later removed (the fork had them early) are counted, not listed.

  fork-delta-check.py [-v] [--fork REF] [--upstream REF] [--merged REF]

Defaults: --fork origin/main, --upstream upstream/main, --merged the working tree, so it works
mid-merge with conflicts still open. Run it before the sync PR merges: afterwards origin/main
already contains the merge and there is nothing left to compare.
"""

import argparse
import os
import re
import subprocess
import sys

SKIP_PREFIXES = (".repos/", ".agent-scratch/", "pnpm-lock.yaml")
# Lines this short or this generic match somewhere in nearly every file and prove nothing.
MIN_LENGTH = 13
GENERIC = re.compile(r"^[\s{}()\[\];,.:*/`'\"<>=|&!?-]*$")
WHITESPACE = re.compile(r"\s+")
# The fork renames product text; undo it before comparing a fork line with upstream's history.
BRAND_ALIASES = (("PseudoCode", "T3 Code"), ("Cloud Connect", "T3 Connect"))


def git(*args, check=True):
    result = subprocess.run(["git", *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed:\n{result.stderr}")
    return result.stdout


def squash(text):
    return WHITESPACE.sub("", text)


def unbrand(text):
    for fork_name, upstream_name in BRAND_ALIASES:
        text = text.replace(fork_name, upstream_name)
    return squash(text)


def meaningful(text):
    return len(text) >= MIN_LENGTH and not GENERIC.match(text)


def fork_hunks(base, fork, path):
    """(added lines, squashed base lines around them) for each hunk of the fork's change.

    The base lines are the ones the fork replaced plus 2 lines of context, so an addition made
    inside a block upstream later deleted is tied to that block.
    """
    hunks = []
    for line in git("diff", "-U2", base, fork, "--", path).splitlines():
        if line.startswith("@@"):
            hunks.append(([], []))
        elif not hunks or line.startswith(("+++", "---")):
            continue
        elif line.startswith("+"):
            text = line[1:].strip()
            if meaningful(text):
                hunks[-1][0].append(text)
        elif line.startswith(("-", " ")) and meaningful(line[1:].strip()):
            hunks[-1][1].append(squash(line[1:]))
    return [hunk for hunk in hunks if hunk[0]]


def merged_content(merged, path):
    if merged is None:
        if not os.path.isfile(path):
            return None
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    result = subprocess.run(["git", "show", f"{merged}:{path}"], capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else None


def find_elsewhere(merged, line):
    args = ["grep", "-l", "-F", "-e", line]
    if merged is not None:
        args.append(merged)
    found = git(*args, check=False).split()
    return [f.split(":", 1)[1] if merged is not None else f for f in found][:3]


def upstream_removed(base, upstream, paths):
    """Squashed lines upstream's own commits removed from these paths since the fork's base."""
    removed = set()
    log = git("log", "-p", "--no-merges", "--format=", f"{base}..{upstream}", "--", *paths)
    for line in log.splitlines():
        if line.startswith("-") and not line.startswith("---"):
            removed.add(squash(line[1:]))
    return removed


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--fork", default="origin/main")
    parser.add_argument("--upstream", default="upstream/main")
    parser.add_argument("--merged", help="commit to check; default is the working tree")
    parser.add_argument("-v", "--verbose", action="store_true", help="print each missing line")
    args = parser.parse_args()

    os.chdir(git("rev-parse", "--show-toplevel").strip())
    base = git("merge-base", args.fork, args.upstream).strip()
    numstat = git("diff", "--numstat", "--diff-filter=AMR", base, args.fork).splitlines()

    checked = 0
    missing = []
    for row in numstat:
        added, _, path = row.split("\t", 2)
        # Binary files show "-"; renames show "old => new" and the new path is what matters.
        if added == "-" or path.startswith(SKIP_PREFIXES):
            continue
        if " => " in path:
            path = re.sub(r"\{[^}]* => ([^}]*)\}", r"\1", path).replace("//", "/")
            path = path.split(" => ")[-1]
        hunks = fork_hunks(base, args.fork, path)
        if not hunks:
            continue
        checked += 1
        content = merged_content(args.merged, path)
        squashed = squash(content) if content is not None else ""
        lost = [
            (line, replaced)
            for lines, replaced in hunks
            for line in lines
            if squash(line) not in squashed
        ]
        if lost:
            missing.append((path, sum(len(h[0]) for h in hunks), lost, content is None))

    removed = upstream_removed(base, args.upstream, [m[0] for m in missing]) if missing else set()
    groups = {"DROPPED": [], "REWRITTEN": []}
    upstream_own = 0
    for path, total, lost, gone in missing:
        by_group = {"DROPPED": [], "REWRITTEN": []}
        for line, replaced in lost:
            if unbrand(line) in removed:
                upstream_own += 1
            elif any(old in removed for old in replaced):
                by_group["REWRITTEN"].append(line)
            else:
                by_group["DROPPED"].append(line)
        for group, lines in by_group.items():
            if lines:
                groups[group].append((path, total, lines, gone))

    for group, files in groups.items():
        print(f"{group}: {sum(len(f[2]) for f in files)} lines in {len(files)} files")
        for path, total, lines, gone in files:
            note = ""
            if gone:
                elsewhere = find_elsewhere(args.merged, lines[0])
                note = f"  (file gone; first line now in {', '.join(elsewhere)})" if elsewhere else "  (file gone)"
            print(f"  {len(lines)}/{total}\t{path}{note}")
            if args.verbose:
                for line in lines[:10]:
                    print(f"      {line[:160]}")
                if len(lines) > 10:
                    print(f"      ... {len(lines) - 10} more")
        print()

    print(
        f"Fork delta {base[:10]}..{args.fork}, {checked} files, checked against"
        f" {args.merged or 'the working tree'}. {upstream_own} missing lines were upstream's own"
        " code that upstream later removed, not listed."
    )


if __name__ == "__main__":
    main()
