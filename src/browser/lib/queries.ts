// Query factory conventions:
//
// - Each factory returns `queryOptions({ queryKey, queryFn, ... })` for use with
//   `useQuery`, `prefetchQuery`, `queryClient.getQueryData`, etc.
//
// - Derived / filtered views use `select` on the same query rather than a
//   separate query key, e.g.:
//     useQuery({ ...queries.currentUser(), select: (u) => u.login })
//
// - Queries with `meta: { persist: true }` are persisted to IndexedDB across
//   sessions via PersistQueryClientProvider. Use for slow-changing data (user
//   profile, collaborators, labels) but NOT for fast-moving data (PR list).
//
// - Mutations follow this pattern:
//     useMutation({
//       mutationFn: myMutationFn,
//       onSuccess: (result, variables) => {
//         queryClient.setQueryData(queries.foo(id).queryKey, (old) => update(old, result));
//       },
//       onSettled: () => queryClient.invalidateQueries({ queryKey: queries.foo(id).queryKey }),
//     })

import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { getOctokit } from "./github-client";
import * as PersistentCache from "./persistent-cache";
import type {
  CurrentUserData,
  IssueComment,
  PRCommit,
  PRSearchResult,
  PullRequest,
  PullRequestFile,
  PushVersion,
  Review,
  ReviewComment,
  TimelineEvent,
  UserProfile,
} from "../contexts/github";
import type { components } from "@octokit/openapi-types";

type AnyUser =
  | components["schemas"]["private-user"]
  | components["schemas"]["public-user"];

function toCurrentUserData(user: AnyUser): CurrentUserData {
  return {
    id: user.id,
    login: user.login,
    name: user.name ?? null,
    email: user.email ?? null,
    avatar_url: user.avatar_url,
    html_url: user.html_url,
    bio: user.bio ?? null,
    company: user.company ?? null,
    location: user.location ?? null,
  };
}

export const queries = {
  currentUser: () =>
    queryOptions({
      queryKey: ["user", "current"],
      queryFn: async ({ signal }) => {
        const r = await getOctokit().request("GET /user", {
          request: { signal },
        });
        return toCurrentUserData(r.data);
      },
      staleTime: 5 * 60_000,
      meta: { persist: true },
    }),

  checksByCommit: (owner: string, repo: string, sha: string) =>
    queryOptions({
      queryKey: ["checks", owner, repo, sha],
      queryFn: async ({ signal }) => {
        const [checkRunsRes, statusRes] = await Promise.all([
          getOctokit().request(
            "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
            { owner, repo, ref: sha, request: { signal } }
          ),
          getOctokit().request(
            "GET /repos/{owner}/{repo}/commits/{ref}/status",
            { owner, repo, ref: sha, request: { signal } }
          ),
        ]);
        return {
          checkRuns: checkRunsRes.data
            .check_runs as components["schemas"]["check-run"][],
          status:
            statusRes.data as components["schemas"]["combined-commit-status"],
        };
      },
      staleTime: 15_000,
    }),

  workflowRunsByCommit: (owner: string, repo: string, sha: string) =>
    queryOptions({
      queryKey: ["workflow-runs", owner, repo, sha],
      queryFn: async ({ signal }) => {
        const res = await getOctokit().request(
          "GET /repos/{owner}/{repo}/actions/runs",
          { owner, repo, head_sha: sha, per_page: 50, request: { signal } }
        );
        return {
          workflow_runs: res.data.workflow_runs as Array<{
            id: number;
            name: string | null;
            status: string | null;
            conclusion: string | null;
            html_url: string;
            head_sha: string;
          }>,
        };
      },
      staleTime: 15_000,
    }),

  collaborators: (owner: string, repo: string) =>
    queryOptions({
      queryKey: ["collaborators", owner, repo],
      queryFn: async ({ signal }) => {
        const res = await getOctokit().request(
          "GET /repos/{owner}/{repo}/collaborators",
          { owner, repo, per_page: 100, request: { signal } }
        );
        return res.data as components["schemas"]["collaborator"][];
      },
      staleTime: 5 * 60_000,
      meta: { persist: true },
    }),

  labels: (owner: string, repo: string) =>
    queryOptions({
      queryKey: ["labels", owner, repo],
      queryFn: async ({ signal }) => {
        const allLabels: Array<{
          name: string;
          color: string;
          description: string | null;
        }> = [];
        let page = 1;
        while (true) {
          const { data } = await getOctokit().request(
            "GET /repos/{owner}/{repo}/labels",
            { owner, repo, per_page: 100, page, request: { signal } }
          );
          for (const l of data) {
            allLabels.push({
              name: l.name,
              color: l.color,
              description: l.description ?? null,
            });
          }
          if (data.length < 100) break;
          page++;
        }
        return allLabels;
      },
      staleTime: 5 * 60_000,
      meta: { persist: true },
    }),

  searchPRs: (query: string, page = 1, perPage = 30) =>
    queryOptions({
      queryKey: ["search", "prs", query, page, perPage],
      queryFn: async ({ signal }) => {
        const res = await getOctokit().request("GET /search/issues", {
          q: query,
          sort: "updated",
          order: "desc",
          per_page: perPage,
          page,
          request: { signal },
        });
        return res.data;
      },
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    }),

  searchRepos: (query: string) =>
    queryOptions({
      queryKey: ["search", "repos", query],
      queryFn: async ({ signal }) => {
        const res = await getOctokit().request("GET /search/repositories", {
          q: query,
          order: "desc",
          per_page: 10,
          request: { signal },
        });
        return res.data;
      },
      staleTime: 60_000,
    }),

  searchUsers: (query: string) =>
    queryOptions({
      queryKey: ["search", "users", query],
      queryFn: async ({ signal }) => {
        const res = await getOctokit().request("GET /search/users", {
          q: query,
          per_page: 8,
          request: { signal },
        });
        return res.data;
      },
      staleTime: 60_000,
    }),

  pullRequest: (owner: string, repo: string, number: number) =>
    queryOptions({
      queryKey: ["pull-request", owner, repo, number],
      queryFn: async ({ signal }) => {
        const res = await getOctokit().request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}",
          {
            owner,
            repo,
            pull_number: number,
            headers: { accept: "application/vnd.github.full+json" },
            request: { signal },
          }
        );
        return res.data as PullRequest;
      },
      staleTime: 30_000,
    }),

  pullRequestFiles: (owner: string, repo: string, number: number) =>
    queryOptions({
      queryKey: ["pull-request", owner, repo, number, "files"],
      queryFn: async ({ signal }) => {
        const files: PullRequestFile[] = [];
        let page = 1;
        while (true) {
          const { data } = await getOctokit().request(
            "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
            {
              owner,
              repo,
              pull_number: number,
              per_page: 100,
              page,
              request: { signal },
            }
          );
          files.push(...data);
          if (data.length < 100) break;
          page++;
        }
        return files;
      },
      staleTime: 30_000,
    }),

  pullRequestCommits: (owner: string, repo: string, number: number) =>
    queryOptions({
      queryKey: ["pull-request", owner, repo, number, "commits"],
      queryFn: async ({ signal }) => {
        const res = await getOctokit().request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
          {
            owner,
            repo,
            pull_number: number,
            per_page: 100,
            request: { signal },
          }
        );
        return res.data as components["schemas"]["commit"][];
      },
      staleTime: 30_000,
    }),

  pullRequestPushVersions: (owner: string, repo: string, number: number) =>
    queryOptions({
      queryKey: ["pull-request", owner, repo, number, "push-versions"],
      queryFn: async ({ signal }) => {
        interface ForcePushNode {
          createdAt: string;
          beforeCommit: { oid: string } | null;
          afterCommit: { oid: string } | null;
        }
        const data = await getOctokit().graphql<{
          repository: {
            pullRequest: {
              createdAt: string;
              timelineItems: { nodes: ForcePushNode[] };
            };
          };
        }>(
          `query GetPushVersions($owner: String!, $repo: String!, $number: Int!) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $number) {
                createdAt
                timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], first: 100) {
                  nodes {
                    ... on HeadRefForcePushedEvent {
                      createdAt
                      beforeCommit { oid }
                      afterCommit { oid }
                    }
                  }
                }
              }
            }
          }`,
          { owner, repo, number, request: { signal } }
        );

        const prData = data.repository.pullRequest;
        const events = (prData.timelineItems.nodes || [])
          .filter((e) => e.createdAt)
          .sort(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );

        if (events.length === 0) return [] as PushVersion[];

        const versions: PushVersion[] = [];

        if (events[0].beforeCommit) {
          versions.push({
            version: 1,
            sha: events[0].beforeCommit.oid,
            pushedAt: prData.createdAt,
          });
        }

        for (const event of events) {
          if (event.afterCommit) {
            versions.push({
              version: versions.length + 1,
              sha: event.afterCommit.oid,
              pushedAt: event.createdAt,
              beforeSha: event.beforeCommit?.oid,
            });
          }
        }

        return versions;
      },
      staleTime: 30_000,
    }),

  pullRequestComments: (owner: string, repo: string, number: number) =>
    queryOptions({
      queryKey: ["pull-request", owner, repo, number, "comments"],
      queryFn: async ({ signal }) => {
        const comments: ReviewComment[] = [];
        let page = 1;
        while (true) {
          const { data } = await getOctokit().request(
            "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
            {
              owner,
              repo,
              pull_number: number,
              per_page: 100,
              page,
              headers: { accept: "application/vnd.github.full+json" },
              request: { signal },
            }
          );
          comments.push(...(data as ReviewComment[]));
          if (data.length < 100) break;
          page++;
        }
        return comments;
      },
      staleTime: 30_000,
    }),

  pullRequestReviews: (owner: string, repo: string, number: number) =>
    queryOptions({
      queryKey: ["pull-request", owner, repo, number, "reviews"],
      queryFn: async ({ signal }) => {
        const res = await getOctokit().request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
          {
            owner,
            repo,
            pull_number: number,
            headers: { accept: "application/vnd.github.full+json" },
            request: { signal },
          }
        );
        return res.data as Review[];
      },
      staleTime: 30_000,
    }),

  pullRequestConversation: (owner: string, repo: string, number: number) =>
    queryOptions({
      queryKey: ["pull-request", owner, repo, number, "conversation"],
      queryFn: async ({ signal }) => {
        const res = await getOctokit().request(
          "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
          {
            owner,
            repo,
            issue_number: number,
            headers: { accept: "application/vnd.github.full+json" },
            request: { signal },
          }
        );
        return res.data as IssueComment[];
      },
      staleTime: 30_000,
    }),

  pullRequestTimeline: (owner: string, repo: string, number: number) =>
    queryOptions({
      queryKey: ["pull-request", owner, repo, number, "timeline"],
      queryFn: async ({ signal }) => {
        const events: TimelineEvent[] = [];
        let page = 1;
        while (true) {
          const { data } = await getOctokit().request(
            "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline",
            {
              owner,
              repo,
              issue_number: number,
              per_page: 100,
              page,
              request: { signal },
            }
          );
          events.push(...(data as TimelineEvent[]));
          if (data.length < 100) break;
          page++;
        }
        return events;
      },
      staleTime: 30_000,
    }),

  issueReactions: (owner: string, repo: string, issueNumber: number) =>
    queryOptions({
      queryKey: ["reactions", "issue", owner, repo, issueNumber],
      queryFn: async ({ signal }) => {
        const res = await getOctokit().request(
          "GET /repos/{owner}/{repo}/issues/{issue_number}/reactions",
          {
            owner,
            repo,
            issue_number: issueNumber,
            per_page: 100,
            request: { signal },
          }
        );
        return res.data as components["schemas"]["reaction"][];
      },
      staleTime: 5 * 60_000,
    }),

  commentReactions: (owner: string, repo: string, commentId: number) =>
    queryOptions({
      queryKey: ["reactions", "comment", owner, repo, commentId],
      queryFn: async ({ signal }) => {
        const res = await getOctokit().request(
          "GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
          {
            owner,
            repo,
            comment_id: commentId,
            per_page: 100,
            request: { signal },
          }
        );
        return res.data as components["schemas"]["reaction"][];
      },
      staleTime: 5 * 60_000,
    }),

  reviewCommentReactions: (owner: string, repo: string, commentId: number) =>
    queryOptions({
      queryKey: ["reactions", "review-comment", owner, repo, commentId],
      queryFn: async ({ signal }) => {
        const res = await getOctokit().request(
          "GET /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
          {
            owner,
            repo,
            comment_id: commentId,
            per_page: 100,
            request: { signal },
          }
        );
        return res.data as components["schemas"]["reaction"][];
      },
      staleTime: 5 * 60_000,
    }),

  userByLogin: (login: string) =>
    queryOptions({
      queryKey: ["user", login],
      queryFn: async ({ signal }) => {
        const res = await getOctokit().request("GET /users/{username}", {
          username: login,
          request: { signal },
        });
        return res.data as UserProfile;
      },
      staleTime: 60 * 60_000,
      meta: { persist: true },
    }),

  commitFiles: (owner: string, repo: string, sha: string, prKey?: string) =>
    queryOptions({
      queryKey: ["commit-files", owner, repo, sha],
      queryFn: async ({ signal }) => {
        const key = `commit:${owner}/${repo}/${sha}:files`;
        const cached = await PersistentCache.get<PullRequestFile[]>(key);
        if (cached) return cached;
        const { data } = await getOctokit().request(
          "GET /repos/{owner}/{repo}/commits/{ref}",
          { owner, repo, ref: sha, request: { signal } }
        );
        const files = (data.files ?? []) as PullRequestFile[];
        if (prKey) await PersistentCache.put(key, files, prKey);
        return files;
      },
      staleTime: Infinity,
      gcTime: 5 * 60_000,
    }),

  singleCommit: (owner: string, repo: string, ref: string, prKey?: string) =>
    queryOptions({
      queryKey: ["single-commit", owner, repo, ref],
      queryFn: async ({ signal }) => {
        const key = `commit:${owner}/${repo}:${ref}`;
        const cached = await PersistentCache.get<PRCommit>(key);
        if (cached) return cached;
        const { data } = await getOctokit().request(
          "GET /repos/{owner}/{repo}/commits/{ref}",
          { owner, repo, ref, request: { signal } }
        );
        const commit = data as PRCommit;
        if (prKey) await PersistentCache.put(key, commit, prKey);
        return commit;
      },
      staleTime: Infinity,
      gcTime: 5 * 60_000,
    }),

  rawGitCommit: (owner: string, repo: string, ref: string, prKey?: string) =>
    queryOptions({
      queryKey: ["raw-git-commit", owner, repo, ref],
      queryFn: async ({ signal }) => {
        const key = `git-commit:${owner}/${repo}:${ref}`;
        type RawCommit = { verification: { payload: string } | null };
        const cached = await PersistentCache.get<RawCommit>(key);
        if (cached) return cached;
        const { data } = await getOctokit().request(
          "GET /repos/{owner}/{repo}/git/commits/{ref}",
          { owner, repo, ref, request: { signal } }
        );
        const commit = data as unknown as RawCommit;
        if (prKey) await PersistentCache.put(key, commit, prKey);
        return commit;
      },
      staleTime: Infinity,
      gcTime: 5 * 60_000,
    }),

  mergeCommitFiles: (
    owner: string,
    repo: string,
    mergeSha: string,
    parentSha: string,
    prKey?: string
  ) =>
    queryOptions({
      queryKey: ["merge-commit-files", owner, repo, mergeSha, parentSha],
      queryFn: async ({ signal }) => {
        const key = `merge:${owner}/${repo}/${mergeSha}:${parentSha}:files`;
        const cached = await PersistentCache.get<PullRequestFile[]>(key);
        if (cached) return cached;
        const { data } = await getOctokit().request(
          "GET /repos/{owner}/{repo}/compare/{basehead}",
          {
            owner,
            repo,
            basehead: `${parentSha}...${mergeSha}`,
            request: { signal },
          }
        );
        const files = (data.files ?? []) as PullRequestFile[];
        if (prKey) await PersistentCache.put(key, files, prKey);
        return files;
      },
      staleTime: Infinity,
      gcTime: 5 * 60_000,
    }),

  rawCompareDiff: (
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
    prKey?: string
  ) =>
    queryOptions({
      queryKey: ["raw-compare-diff", owner, repo, baseSha, headSha],
      queryFn: async ({ signal }) => {
        const key = `rawdiff:${owner}/${repo}/${baseSha}...${headSha}`;
        const cached = await PersistentCache.get<string>(key);
        if (cached) return cached;
        const { data } = await getOctokit().request(
          "GET /repos/{owner}/{repo}/compare/{basehead}",
          {
            owner,
            repo,
            basehead: `${baseSha}...${headSha}`,
            headers: { Accept: "application/vnd.github.diff" },
            request: { signal },
          }
        );
        const text = data as unknown as string;
        if (prKey) await PersistentCache.put(key, text, prKey);
        return text;
      },
      staleTime: Infinity,
      gcTime: 5 * 60_000,
    }),

  prFilesForRange: (
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
    prKey?: string
  ) =>
    queryOptions({
      queryKey: ["pr-files-for-range", owner, repo, baseSha, headSha],
      queryFn: async ({ signal }) => {
        const key = `compare:${owner}/${repo}/${baseSha}...${headSha}:files`;
        const cached = await PersistentCache.get<PullRequestFile[]>(key);
        if (cached) return cached;
        const { data } = await getOctokit().request(
          "GET /repos/{owner}/{repo}/compare/{basehead}",
          {
            owner,
            repo,
            basehead: `${baseSha}...${headSha}`,
            per_page: 100,
            request: { signal },
          }
        );
        const files = (data.files ?? []) as PullRequestFile[];
        if (prKey) await PersistentCache.put(key, files, prKey);
        return files;
      },
      staleTime: Infinity,
      gcTime: 5 * 60_000,
    }),

  commitsForHeadSha: (
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
    prKey?: string
  ) =>
    queryOptions({
      queryKey: ["commits-for-head-sha", owner, repo, baseSha, headSha],
      queryFn: async ({ signal }) => {
        const key = `compare:${owner}/${repo}/${baseSha}...${headSha}:commits`;
        type CommitList = components["schemas"]["commit"][];
        const cached = await PersistentCache.get<CommitList>(key);
        if (cached) return cached;
        const { data } = await getOctokit().request(
          "GET /repos/{owner}/{repo}/compare/{basehead}",
          {
            owner,
            repo,
            basehead: `${baseSha}...${headSha}`,
            per_page: 100,
            request: { signal },
          }
        );
        const commits = data.commits as CommitList;
        if (prKey) await PersistentCache.put(key, commits, prKey);
        return commits;
      },
      staleTime: Infinity,
      gcTime: 5 * 60_000,
    }),

  fileContent: (
    owner: string,
    repo: string,
    path: string,
    ref: string,
    prKey?: string
  ) =>
    queryOptions({
      queryKey: ["file-content", owner, repo, path, ref],
      queryFn: async ({ signal }) => {
        const key = `file:${owner}/${repo}/${ref}/${path}`;
        const cached = await PersistentCache.get<string>(key);
        if (cached !== null) return cached;
        try {
          const { data } = await getOctokit().request(
            "GET /repos/{owner}/{repo}/contents/{path}",
            {
              owner,
              repo,
              path,
              ref,
              headers: { Accept: "application/vnd.github.raw+json" },
              request: { signal },
            }
          );
          const content = data as unknown as string;
          if (prKey) await PersistentCache.put(key, content, prKey);
          return content;
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "status" in error &&
            (error as { status: number }).status === 404
          ) {
            if (prKey) await PersistentCache.put(key, "", prKey);
            return "";
          }
          throw error;
        }
      },
      staleTime: Infinity,
      gcTime: 5 * 60_000,
    }),

  prList: (queryStrings: string[], page = 1, perPage = 30) =>
    queryOptions({
      queryKey: ["pr-list", [...queryStrings].sort(), page, perPage],
      queryFn: async ({ signal }) => {
        if (queryStrings.length === 0) {
          return { items: [] as PRSearchResult[], totalCount: 0 };
        }

        const results = await Promise.all(
          queryStrings.map((q) =>
            getOctokit()
              .request("GET /search/issues", {
                q,
                sort: "updated",
                order: "desc",
                per_page: perPage,
                page,
                request: { signal },
              })
              .then((r) => r.data)
          )
        );

        const seen = new Set<number>();
        const combined: PRSearchResult[] = [];
        let totalCount = 0;

        for (const data of results) {
          totalCount += data.total_count ?? 0;
          for (const pr of (data.items ?? []) as PRSearchResult[]) {
            if (!seen.has(pr.id)) {
              seen.add(pr.id);
              combined.push(pr);
            }
          }
        }

        combined.sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );

        const prIdentifiers = combined
          .map((item) => {
            const match = item.repository_url?.match(/repos\/([^/]+)\/([^/]+)/);
            if (match && item.number) {
              return { owner: match[1], repo: match[2], number: item.number };
            }
            return null;
          })
          .filter(
            (x): x is { owner: string; repo: string; number: number } =>
              x !== null
          );

        if (prIdentifiers.length > 0 && !signal?.aborted) {
          try {
            const enrichmentMap = await _enrichPRs(prIdentifiers, signal);
            for (const item of combined) {
              const match = item.repository_url?.match(
                /repos\/([^/]+)\/([^/]+)/
              );
              if (match && item.number) {
                const key = `${match[1]}/${match[2]}/${item.number}`;
                const enrichment = enrichmentMap.get(key);
                if (enrichment) Object.assign(item, enrichment);
              }
            }
          } catch (e) {
            console.error("PR enrichment failed:", e);
          }
        }

        return { items: combined, totalCount };
      },
      staleTime: 30_000,
      placeholderData: keepPreviousData,
    }),
};

type CheckContext =
  | {
      __typename: "CheckRun";
      name: string;
      conclusion: string | null;
      status: string;
    }
  | { __typename: "StatusContext"; context: string; state: string };

type EnrichmentResult = {
  changedFiles: number;
  additions: number;
  deletions: number;
  updatedAt: string;
  isReadByViewer: boolean;
  lastCommitAt: string | null;
  viewerLastReviewAt: string | null;
  hasNewChanges: boolean;
  ciStatus: "pending" | "success" | "failure" | "none" | "action_required";
  ciSummary: string;
  ciChecks: Array<{
    name: string;
    state: "pending" | "success" | "failure" | "skipped";
  }>;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  latestReviews: Array<{
    login: string;
    avatarUrl: string;
    state: "APPROVED" | "CHANGES_REQUESTED";
  }>;
  inMergeQueue: boolean;
};

async function _enrichPRs(
  prs: Array<{ owner: string; repo: string; number: number }>,
  signal?: AbortSignal
): Promise<Map<string, EnrichmentResult>> {
  const prQueries = prs
    .map(
      (pr, idx) => `
    pr${idx}: repository(owner: "${pr.owner}", name: "${pr.repo}") {
      pullRequest(number: ${pr.number}) {
        number
        updatedAt
        isReadByViewer
        changedFiles
        additions
        deletions
        isInMergeQueue
        reviewDecision
        latestOpinionatedReviews(first: 10) {
          nodes {
            author { login avatarUrl }
            state
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              committedDate
              statusCheckRollup {
                state
                contexts(first: 50) {
                  nodes {
                    __typename
                    ... on CheckRun { name conclusion status }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
        viewerLatestReview { submittedAt }
      }
    }`
    )
    .join("\n");

  const data = await getOctokit().graphql<
    Record<
      string,
      {
        pullRequest: {
          number: number;
          updatedAt: string;
          isReadByViewer: boolean;
          changedFiles: number;
          additions: number;
          deletions: number;
          isInMergeQueue: boolean;
          reviewDecision:
            | "APPROVED"
            | "CHANGES_REQUESTED"
            | "REVIEW_REQUIRED"
            | null;
          latestOpinionatedReviews: {
            nodes: Array<{
              author: { login: string; avatarUrl: string } | null;
              state: "APPROVED" | "CHANGES_REQUESTED";
            }>;
          };
          commits: {
            nodes: Array<{
              commit: {
                committedDate: string;
                statusCheckRollup: {
                  state:
                    | "EXPECTED"
                    | "ERROR"
                    | "FAILURE"
                    | "PENDING"
                    | "SUCCESS";
                  contexts: { nodes: CheckContext[] };
                } | null;
              };
            }>;
          };
          viewerLatestReview: { submittedAt: string } | null;
        } | null;
      }
    >
  >(`query { ${prQueries} }`, { request: { signal } });

  const enrichmentMap = new Map<string, EnrichmentResult>();

  prs.forEach((pr, idx) => {
    const result = data[`pr${idx}`]?.pullRequest;
    if (!result) return;

    const lastCommit = result.commits.nodes[0]?.commit;
    const lastCommitAt = lastCommit?.committedDate ?? null;
    const viewerLastReviewAt = result.viewerLatestReview?.submittedAt ?? null;
    const hasNewChanges =
      viewerLastReviewAt != null &&
      lastCommitAt != null &&
      new Date(lastCommitAt) > new Date(viewerLastReviewAt);

    const statusState = lastCommit?.statusCheckRollup?.state;
    let ciStatus: EnrichmentResult["ciStatus"] = "none";
    if (statusState === "SUCCESS") ciStatus = "success";
    else if (statusState === "FAILURE" || statusState === "ERROR")
      ciStatus = "failure";
    else if (statusState === "PENDING" || statusState === "EXPECTED")
      ciStatus = "pending";

    const contexts = lastCommit?.statusCheckRollup?.contexts?.nodes ?? [];
    const ciChecks: EnrichmentResult["ciChecks"] = contexts.map((ctx) => {
      if (ctx.__typename === "CheckRun") {
        let state: "pending" | "success" | "failure" | "skipped" = "pending";
        if (ctx.status === "COMPLETED") {
          if (ctx.conclusion === "SUCCESS") state = "success";
          else if (
            ["SKIPPED", "NEUTRAL", "CANCELLED"].includes(ctx.conclusion ?? "")
          )
            state = "skipped";
          else state = "failure";
        }
        return { name: ctx.name, state };
      }
      const state =
        ctx.state === "SUCCESS"
          ? "success"
          : ctx.state === "FAILURE" || ctx.state === "ERROR"
            ? "failure"
            : "pending";
      return { name: ctx.context, state };
    });

    let ciSummary = "";
    if (ciChecks.length > 0) {
      const passed = ciChecks.filter((c) => c.state === "success").length;
      const failed = ciChecks.filter((c) => c.state === "failure").length;
      const pending = ciChecks.filter((c) => c.state === "pending").length;
      const skipped = ciChecks.filter((c) => c.state === "skipped").length;
      if (failed > 0) {
        ciSummary =
          ciChecks.find((c) => c.state === "failure")?.name ??
          `${failed} failed`;
      } else if (pending > 0) {
        ciSummary =
          ciChecks.find((c) => c.state === "pending")?.name ??
          `${pending} running`;
      } else {
        const nonSkipped = ciChecks.length - skipped;
        ciSummary =
          nonSkipped > 0 ? `${passed}/${nonSkipped} passed` : "All skipped";
      }
    }

    const reviewsByUser = new Map<
      string,
      {
        login: string;
        avatarUrl: string;
        state: "APPROVED" | "CHANGES_REQUESTED";
      }
    >();
    for (const review of result.latestOpinionatedReviews?.nodes ?? []) {
      if (review.author) {
        reviewsByUser.set(review.author.login, {
          login: review.author.login,
          avatarUrl: review.author.avatarUrl,
          state: review.state,
        });
      }
    }

    enrichmentMap.set(`${pr.owner}/${pr.repo}/${pr.number}`, {
      changedFiles: result.changedFiles,
      additions: result.additions,
      deletions: result.deletions,
      updatedAt: result.updatedAt,
      isReadByViewer: result.isReadByViewer,
      lastCommitAt,
      viewerLastReviewAt,
      hasNewChanges,
      ciStatus,
      ciSummary,
      ciChecks,
      reviewDecision: result.reviewDecision,
      latestReviews: Array.from(reviewsByUser.values()),
      inMergeQueue: result.isInMergeQueue,
    });
  });

  return enrichmentMap;
}
