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

import { queryOptions } from "@tanstack/react-query";
import { getOctokit } from "./github-client";
import type { CurrentUserData } from "../contexts/github";
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
};
