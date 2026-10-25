import type { SourceControlProviderKind } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

/**
 * An issue the panel can open, named the way a project's repository identity names one.
 *
 * Kept apart from the change-request matcher next door because the answer is different: a change
 * request opens the pull request surface, an issue opens the issues surface, and the two paths
 * are told apart only by what the host wrote in the URL.
 */
export interface IssueLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

/**
 * GitHub and Forgejo share `/{owner}/{repo}/issues/{n}`, distinctive enough to trust on any host,
 * since Forgejo hostnames are arbitrary. Null keeps the system browser: a doubtful match would
 * open a panel that cannot find the issue.
 */
export function parseIssueUrl(targetUrl: string): IssueLink | null {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // A trailing segment means a comment anchor or a sub-page, not the issue itself.
  const match = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u.exec(url.pathname);
  const repository = match?.[1];
  const number = Number(match?.[2]);
  if (!repository || !Number.isSafeInteger(number) || number <= 0) return null;
  return { host: url.hostname.toLowerCase(), repository: repository.toLowerCase(), number };
}

/**
 * The project an issue link belongs to, matched the way the server matches: the repository is
 * the full path below the host, and the host is the first segment of the canonical remote, so
 * github.com and an Enterprise install stay apart.
 */
export function findProjectForIssue(
  projects: ReadonlyArray<EnvironmentProject>,
  link: IssueLink,
): EnvironmentProject | undefined {
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    if (!identity) return false;
    const kind = identity.provider as SourceControlProviderKind | undefined;
    if (kind === undefined) return false;
    const repository =
      identity.displayName ??
      (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
    return (
      repository !== null &&
      repository.toLowerCase() === link.repository &&
      sourceControlClients.changeRequestHost(identity, kind) === link.host
    );
  });
}
