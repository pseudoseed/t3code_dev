import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ForgejoCli from "./ForgejoCli.ts";
import { discovery, make } from "./ForgejoSourceControlProvider.ts";

const login = (url: string) => ({ name: url, url, user: "pat-s", valid: "true", default: "false" });
const authOutput = JSON.stringify([
  login("https://codeberg.org"),
  login("https://git.example.org"),
]);

describe("Forgejo discovery", () => {
  it("refines an unknown remote logged in with a token and no account", () => {
    const refined = discovery.refineUnknownRemote!({
      cwd: "/repo",
      context: {
        provider: { kind: "unknown", name: "git.example.org", baseUrl: "https://git.example.org" },
        remoteName: "origin",
        remoteUrl: "https://git.example.org/owner/repo",
      },
      auth: {
        stdout: JSON.stringify([login("https://git.example.org")]),
        stderr: "",
        exitCode: ChildProcessSpawner.ExitCode(0),
      },
    });
    assert.deepStrictEqual(refined, {
      kind: "forgejo",
      name: "Forgejo / Gitea",
      baseUrl: "https://git.example.org",
    });
  });

  it("refines an unknown remote whose host is logged in", () => {
    const refined = discovery.refineUnknownRemote!({
      cwd: "/repo",
      context: {
        provider: { kind: "unknown", name: "git.example.org", baseUrl: "https://git.example.org" },
        remoteName: "origin",
        remoteUrl: "git@git.example.org:owner/repo.git",
      },
      auth: { stdout: authOutput, stderr: "", exitCode: ChildProcessSpawner.ExitCode(0) },
    });
    assert.deepStrictEqual(refined, {
      kind: "forgejo",
      name: "Forgejo / Gitea",
      baseUrl: "https://git.example.org",
    });
  });

  it("refines an unknown remote whose host differs only in case", () => {
    const refined = discovery.refineUnknownRemote!({
      cwd: "/repo",
      context: {
        provider: { kind: "unknown", name: "Git.Example.Org", baseUrl: "https://Git.Example.Org" },
        remoteName: "origin",
        remoteUrl: "git@Git.Example.Org:owner/repo.git",
      },
      auth: { stdout: authOutput, stderr: "", exitCode: ChildProcessSpawner.ExitCode(0) },
    });
    assert.deepStrictEqual(refined, {
      kind: "forgejo",
      name: "Forgejo / Gitea",
      baseUrl: "https://git.example.org",
    });
  });

  it("refines a remote whose port matches its configured login", () => {
    const refined = discovery.refineUnknownRemote!({
      cwd: "/repo",
      context: {
        provider: {
          kind: "unknown",
          name: "git.example.org:3000",
          baseUrl: "https://git.example.org:3000",
        },
        remoteName: "origin",
        remoteUrl: "https://git.example.org:3000/owner/repo.git",
      },
      auth: {
        stdout: JSON.stringify([login("https://git.example.org:3000")]),
        stderr: "",
        exitCode: ChildProcessSpawner.ExitCode(0),
      },
    });
    assert.deepStrictEqual(refined, {
      kind: "forgejo",
      name: "Forgejo / Gitea",
      baseUrl: "https://git.example.org:3000",
    });
  });

  it("does not refine a host that is not logged in", () => {
    const refined = discovery.refineUnknownRemote!({
      cwd: "/repo",
      context: {
        provider: { kind: "unknown", name: "git.other.org", baseUrl: "https://git.other.org" },
        remoteName: "origin",
        remoteUrl: "git@git.other.org:owner/repo.git",
      },
      auth: { stdout: authOutput, stderr: "", exitCode: ChildProcessSpawner.ExitCode(0) },
    });
    assert.strictEqual(refined, null);
  });

  it("reports authenticated status from auth output", () => {
    const auth = discovery.parseAuth({
      stdout: authOutput,
      stderr: "",
      exitCode: ChildProcessSpawner.ExitCode(0),
    });
    assert.strictEqual(auth.status, "authenticated");
  });
});

const pull = (number: number, head: string, owner = "owner") => ({
  number,
  title: `Change ${number}`,
  html_url: `https://git.example.org/owner/repo/pulls/${number}`,
  state: "open",
  merged: false,
  base: { ref: "main", repo: { full_name: "owner/repo", owner: { login: "owner" } } },
  head: { ref: head, repo: { full_name: `${owner}/repo`, owner: { login: owner } } },
});

/** Serves `/pulls` in pages of 50, narrowing by `head` only when the server version would. */
function makeForgejo(input: {
  readonly pulls: ReadonlyArray<ReturnType<typeof pull>>;
  readonly honoursHeadFilter: boolean;
}) {
  const requests: Array<URLSearchParams> = [];
  const provider = make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ForgejoCli.ForgejoCli)({
          resolveRepository: () =>
            Effect.succeed({
              command: "fj" as const,
              login: "git.example.org",
              repository: "owner/repo",
              baseUrl: "https://git.example.org",
            }),
          api: (request) => {
            const query = new URL(request.path, "https://git.example.org/api/v1/").searchParams;
            requests.push(query);
            const head = query.get("head");
            const page = Number(query.get("page"));
            const rows = input.pulls
              .filter((row) => !input.honoursHeadFilter || head === null || row.head.ref === head)
              .slice((page - 1) * 50, page * 50);
            return Effect.succeed({
              exitCode: ChildProcessSpawner.ExitCode(0),
              stdout: JSON.stringify(rows),
              stderr: "HTTP/1.1 200\n",
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          },
        }),
        Layer.mock(VcsProcess.VcsProcess)({}),
        FileSystem.layerNoop({}),
      ),
    ),
  );
  return { provider, requests };
}

const otherBranches = (count: number) =>
  Array.from({ length: count }, (_, index) => pull(1_000 + index, `other/${index}`));

describe("Forgejo branch pull request lookup", () => {
  it.effect("finds a branch's pull request with one filtered request", () =>
    Effect.gen(function* () {
      const forgejo = makeForgejo({
        pulls: [...otherBranches(120), pull(7, "fix/#41")],
        honoursHeadFilter: true,
      });
      const provider = yield* forgejo.provider;

      const found = yield* provider.listChangeRequests({
        cwd: "/repo",
        headSelector: "fix/#41",
        state: "open",
        limit: 1,
      });

      assert.deepStrictEqual(
        found.map((changeRequest) => changeRequest.number),
        [7],
      );
      assert.deepStrictEqual(
        forgejo.requests.map((query) => query.get("head")),
        ["fix/#41"],
      );
    }),
  );

  it.effect("answers a branch without a pull request after one request", () =>
    Effect.gen(function* () {
      const forgejo = makeForgejo({ pulls: otherBranches(1_000), honoursHeadFilter: true });
      const provider = yield* forgejo.provider;

      const found = yield* provider.listChangeRequests({
        cwd: "/repo",
        headSelector: "feature/no-pr",
        state: "all",
        limit: 20,
      });

      assert.deepStrictEqual(found, []);
      assert.strictEqual(forgejo.requests.length, 1);
    }),
  );

  it.effect("filters by the bare branch and keeps the owner check for owner selectors", () =>
    Effect.gen(function* () {
      const forgejo = makeForgejo({
        pulls: [pull(8, "feature/x"), pull(9, "feature/x", "fork")],
        honoursHeadFilter: true,
      });
      const provider = yield* forgejo.provider;

      const found = yield* provider.listChangeRequests({
        cwd: "/repo",
        headSelector: "fork:feature/x",
        state: "open",
        limit: 20,
      });

      assert.deepStrictEqual(
        found.map((changeRequest) => changeRequest.number),
        [9],
      );
      assert.strictEqual(forgejo.requests[0]?.get("head"), "feature/x");
    }),
  );

  it.effect("caps the scan on servers that ignore the head filter", () =>
    Effect.gen(function* () {
      const forgejo = makeForgejo({ pulls: otherBranches(1_000), honoursHeadFilter: false });
      const provider = yield* forgejo.provider;

      const found = yield* provider.listChangeRequests({
        cwd: "/repo",
        headSelector: "feature/no-pr",
        state: "open",
        limit: 1,
      });

      assert.deepStrictEqual(found, []);
      assert.deepStrictEqual(
        forgejo.requests.map((query) => query.get("page")),
        ["1", "2", "3", "4", "5"],
      );
    }),
  );

  it.effect("still finds a recent pull request on servers that ignore the head filter", () =>
    Effect.gen(function* () {
      const pulls = otherBranches(1_000);
      pulls.splice(70, 0, pull(7, "feature/x"));
      const forgejo = makeForgejo({ pulls, honoursHeadFilter: false });
      const provider = yield* forgejo.provider;

      const found = yield* provider.listChangeRequests({
        cwd: "/repo",
        headSelector: "feature/x",
        state: "open",
        limit: 1,
      });

      assert.deepStrictEqual(
        found.map((changeRequest) => changeRequest.number),
        [7],
      );
      assert.strictEqual(forgejo.requests.length, 2);
    }),
  );
});
