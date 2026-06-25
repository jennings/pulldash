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
import type { CurrentUserData, PRSearchResult } from "../contexts/github";
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
      queryFn: async () => {
        const r = await getOctokit().request("GET /user");
        return toCurrentUserData(r.data);
      },
      staleTime: 5 * 60_000,
      meta: { persist: true },
    }),

  checksByCommit: (owner: string, repo: string, sha: string) =>
    queryOptions({
      queryKey: ["checks", owner, repo, sha],
      queryFn: async () => {
        const [checkRunsRes, statusRes] = await Promise.all([
          getOctokit().request(
            "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
            { owner, repo, ref: sha }
          ),
          getOctokit().request(
            "GET /repos/{owner}/{repo}/commits/{ref}/status",
            { owner, repo, ref: sha }
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
      queryFn: async () => {
        const res = await getOctokit().request(
          "GET /repos/{owner}/{repo}/actions/runs",
          { owner, repo, head_sha: sha, per_page: 50 }
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
      queryFn: async () => {
        const res = await getOctokit().request(
          "GET /repos/{owner}/{repo}/collaborators",
          { owner, repo, per_page: 100 }
        );
        return res.data as components["schemas"]["collaborator"][];
      },
      staleTime: 5 * 60_000,
      meta: { persist: true },
    }),

  labels: (owner: string, repo: string) =>
    queryOptions({
      queryKey: ["labels", owner, repo],
      queryFn: async () => {
        const allLabels: Array<{
          name: string;
          color: string;
          description: string | null;
        }> = [];
        let page = 1;
        while (true) {
          const { data } = await getOctokit().request(
            "GET /repos/{owner}/{repo}/labels",
            { owner, repo, per_page: 100, page }
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
      queryFn: async () => {
        const res = await getOctokit().request("GET /search/repositories", {
          q: query,
          order: "desc",
          per_page: 10,
        });
        return res.data;
      },
      staleTime: 60_000,
    }),

  searchUsers: (query: string) =>
    queryOptions({
      queryKey: ["search", "users", query],
      queryFn: async () => {
        const res = await getOctokit().request("GET /search/users", {
          q: query,
          per_page: 8,
        });
        return res.data;
      },
      staleTime: 60_000,
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
            const enrichmentMap = await _enrichPRs(prIdentifiers);
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
  prs: Array<{ owner: string; repo: string; number: number }>
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
  >(`query { ${prQueries} }`);

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
