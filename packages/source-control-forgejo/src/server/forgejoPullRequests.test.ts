import { assert, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { repositoryNameFromRemoteUrl } from "./ForgejoSourceControlProvider.ts";
import {
  ForgejoPullRequestSchema,
  normalizeForgejoPullRequestRecord,
  toForgejoChangeRequest,
} from "./forgejoPullRequests.ts";

const decodeForgejoPullRequest = Schema.decodeEffect(ForgejoPullRequestSchema);
const decode = Schema.decodeUnknownEffect(ForgejoPullRequestSchema);

it.effect("normalizes a same-repository open PR", () =>
  Effect.gen(function* () {
    const raw = yield* decode({
      number: 42,
      title: "Add Forgejo provider",
      state: "open",
      merged: false,
      html_url: "https://codeberg.org/owner/repo/pulls/42",
      updated_at: "2026-01-02T00:00:00.000Z",
      base: { ref: "main", repo: { full_name: "owner/repo" } },
      head: { ref: "feature/forgejo", repo: { full_name: "owner/repo" } },
    });
    assert.deepStrictEqual(normalizeForgejoPullRequestRecord(raw), {
      number: 42,
      title: "Add Forgejo provider",
      url: "https://codeberg.org/owner/repo/pulls/42",
      baseRefName: "main",
      headRefName: "feature/forgejo",
      state: "open",
      closedAt: null,
      mergedAt: null,
      updatedAt: Option.some(DateTime.makeUnsafe("2026-01-02T00:00:00.000Z")),
    });
  }),
);

it.effect("marks merged PRs and cross-repository PRs", () =>
  Effect.gen(function* () {
    const raw = yield* decode({
      number: 7,
      title: "Fork PR",
      state: "closed",
      merged: true,
      html_url: "https://codeberg.org/owner/repo/pulls/7",
      base: { ref: "main", repo: { full_name: "owner/repo" } },
      head: {
        ref: "patch",
        repo: { full_name: "forker/repo", owner: { login: "forker" } },
      },
    });
    const record = normalizeForgejoPullRequestRecord(raw);
    assert.strictEqual(record.state, "merged");
    assert.strictEqual(record.isCrossRepository, true);
    assert.strictEqual(record.headRepositoryNameWithOwner, "forker/repo");
    assert.strictEqual(record.headRepositoryOwnerLogin, "forker");
  }),
);

it.effect("names a mounted server's heads by owner and repository, apart from forks", () =>
  Effect.gen(function* () {
    for (const owner of ["maria", "reviewer"]) {
      const changeRequest = toForgejoChangeRequest(
        yield* decodeForgejoPullRequest({
          number: 42,
          title: "Greeting",
          html_url: "https://forgejo.example/forgejo/maria/project/pulls/42",
          state: "open",
          merged: false,
          base: {
            ref: "main",
            sha: "base",
            repo: { full_name: "maria/project", owner: { login: "maria" } },
          },
          head: {
            ref: "greeting",
            sha: "head",
            repo: { full_name: `${owner}/project`, owner: { login: owner } },
          },
        }),
      );
      expect(changeRequest).toMatchObject({
        headRefName: "greeting",
        isCrossRepository: owner !== "maria",
        headRepositoryNameWithOwner: `${owner}/project`,
        headRepositoryOwnerLogin: owner,
      });
      expect(
        repositoryNameFromRemoteUrl(`https://forgejo.example/forgejo/${owner}/project.git`),
      ).toBe(`${owner}/project`);
    }
    expect(repositoryNameFromRemoteUrl("git@forgejo.example:maria/project.git")).toBe(
      "maria/project",
    );
  }),
);
