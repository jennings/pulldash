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
};
