import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubIssueProvider from "./GitHubIssueProvider.ts";

const execute = vi.fn<GitHubCli.GitHubCli["Service"]["execute"]>();

const layer = it.layer(Layer.mock(GitHubCli.GitHubCli)({ execute }));

function output(stdout: string) {
  return Effect.succeed({
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
}

/** The last command `gh` was asked to run. */
function lastArgs(): ReadonlyArray<string> {
  return execute.mock.calls.at(-1)?.[0].args ?? [];
}

const target = { cwd: "/repo", host: "github.com", repository: "acme/web" };

const issueJson = (overrides: Record<string, unknown> = {}) => ({
  number: 12,
  title: "Cache is never invalidated",
  url: "https://github.com/acme/web/issues/12",
  state: "OPEN",
  createdAt: "2026-06-16T05:04:32Z",
  updatedAt: "2026-06-16T05:04:33Z",
  author: { login: "bilal", name: "Bilal" },
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: [{ login: "octocat" }],
  ...overrides,
});

layer("lists issues", (it) => {
  it.effect("asks gh for the repository, state and fields it needs", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      execute.mockReturnValue(output(JSON.stringify([issueJson()])));
      const provider = yield* GitHubIssueProvider.make;
      const page = yield* provider.listIssues({
        ...target,
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 20,
      });

      assert.deepStrictEqual(
        page.items.map((item) => [item.number, item.state, item.title]),
        [[12, "open", "Cache is never invalidated"]],
      );
      assert.deepStrictEqual(page.items[0]?.labels, [{ name: "bug", color: "d73a4a" }]);
      assert.deepStrictEqual(
        page.items[0]?.assignees.map((entry) => entry.login),
        ["octocat"],
      );
      const args = lastArgs();
      assert.deepStrictEqual(args.slice(0, 6), [
        "issue",
        "list",
        "--repo",
        "github.com/acme/web",
        "--state",
        "open",
      ]);
    }),
  );

  it.effect("hands a search term to GitHub rather than filtering here", () =>
    Effect.gen(function* () {
      execute.mockReturnValue(output("[]"));
      const provider = yield* GitHubIssueProvider.make;
      yield* provider.listIssues({
        ...target,
        state: "all",
        involvement: "assigned",
        viewer: "bilal",
        limit: 20,
        query: "cache",
      });
      const args = lastArgs();
      assert.ok(args.includes("--search"), args.join(" "));
      assert.ok(args.includes("cache"), args.join(" "));
      assert.ok(args.includes("--assignee"), args.join(" "));
      assert.ok(args.includes("@me"), args.join(" "));
    }),
  );
});

layer("reads one issue", (it) => {
  it.effect("carries the conversation and whether this account may write", () =>
    Effect.gen(function* () {
      execute.mockImplementation((input) =>
        input.args[0] === "repo"
          ? // @effect-diagnostics-next-line preferSchemaOverJson:off
            output(JSON.stringify({ viewerPermission: "READ" }))
          : output(
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify(
                issueJson({
                  body: "It never clears.",
                  closedAt: null,
                  comments: [
                    {
                      id: "IC_1",
                      body: "Confirmed",
                      createdAt: "2026-06-16T06:00:00Z",
                      url: "https://github.com/acme/web/issues/12#issuecomment-1",
                      author: { login: "octocat" },
                    },
                  ],
                }),
              ),
            ),
      );
      const provider = yield* GitHubIssueProvider.make;
      const detail = yield* provider.getIssue({ ...target, number: 12 });
      assert.strictEqual(detail.body, "It never clears.");
      assert.strictEqual(detail.comments.length, 1);
      assert.strictEqual(detail.comments[0]?.author?.login, "octocat");
      // Read access is not write access, so the composer stays hidden.
      assert.strictEqual(detail.viewerCanWrite, false);
      assert.strictEqual(detail.commentsTruncated, false);
    }),
  );

  it.effect("treats a permission it could not read as write", () =>
    Effect.gen(function* () {
      execute.mockImplementation((input) =>
        input.args[0] === "repo"
          ? Effect.fail(
              new GitHubCli.GitHubCliCommandError({
                command: "gh",
                cwd: "/repo",
                cause: new Error("no"),
              }),
            )
          : // @effect-diagnostics-next-line preferSchemaOverJson:off
            output(JSON.stringify(issueJson({ body: "", comments: [] }))),
      );
      const provider = yield* GitHubIssueProvider.make;
      const detail = yield* provider.getIssue({ ...target, number: 12 });
      // Hiding the composer from someone entitled to write is the worse of the two mistakes.
      assert.strictEqual(detail.viewerCanWrite, true);
    }),
  );
});

layer("writes", (it) => {
  it.effect("sends a comment body on stdin rather than in the command line", () =>
    Effect.gen(function* () {
      execute.mockReturnValue(output(""));
      const provider = yield* GitHubIssueProvider.make;
      yield* provider.comment({ ...target, number: 12, body: "on it" });
      const call = execute.mock.calls.at(-1)?.[0];
      assert.strictEqual(call?.stdin, "on it");
      assert.ok(call?.args.includes("--body-file"), call?.args.join(" "));
      assert.ok(!call?.args.includes("on it"), "the body must not reach argv");
    }),
  );

  it.effect("reads the new issue's number out of the URL gh prints", () =>
    Effect.gen(function* () {
      execute.mockReturnValue(output("https://github.com/acme/web/issues/99\n"));
      const provider = yield* GitHubIssueProvider.make;
      const created = yield* provider.createIssue({
        ...target,
        title: "Something broke",
        body: "details",
      });
      assert.deepStrictEqual(created, {
        number: 99,
        url: "https://github.com/acme/web/issues/99",
      });
    }),
  );

  it.effect("fails rather than guess when gh reports no URL", () =>
    Effect.gen(function* () {
      execute.mockReturnValue(output("Creating issue...\n"));
      const provider = yield* GitHubIssueProvider.make;
      const exit = yield* Effect.exit(provider.createIssue({ ...target, title: "x", body: "" }));
      assert.strictEqual(exit._tag, "Failure");
    }),
  );

  it.effect("closes and reopens through the matching gh subcommand", () =>
    Effect.gen(function* () {
      execute.mockReturnValue(output(""));
      const provider = yield* GitHubIssueProvider.make;
      yield* provider.setState({ ...target, number: 12, state: "closed" });
      assert.deepStrictEqual(lastArgs().slice(0, 3), ["issue", "close", "12"]);
      yield* provider.setState({ ...target, number: 12, state: "open" });
      assert.deepStrictEqual(lastArgs().slice(0, 3), ["issue", "reopen", "12"]);
    }),
  );
});

layer("classifies failures", (it) => {
  it.effect("reports a missing CLI as a missing tool rather than a failed request", () =>
    Effect.gen(function* () {
      execute.mockReturnValue(
        Effect.fail(
          new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: "/repo",
            cause: new Error("gh not found"),
          }),
        ),
      );
      const provider = yield* GitHubIssueProvider.make;
      const error = yield* Effect.flip(
        provider.listIssues({
          ...target,
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
        }),
      );
      // The service turns this into "install gh", rather than into one failed listing.
      assert.strictEqual(error.reason, "missing-tool");
      assert.strictEqual(error.provider, "github");
    }),
  );
});
