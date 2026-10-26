import { test, expect } from "bun:test";
import "fake-indexeddb/auto";
import { queries } from "./queries";
import { setOctokit } from "./github-client";
import type { Review } from "@/api/types";
import { QueryClient } from "@tanstack/react-query";

const review = (id: number): Review =>
  ({
    id,
    user: { login: `user-${id}` },
    state: "APPROVED",
  }) as unknown as Review;

test("UPDATED candidates include later search pages and deduplicate overlapping filters", async () => {
  const calls: Array<{ q: string; page: number; per_page: number }> = [];
  const batches: number[] = [];
  const item = (id: number) => ({
    id,
    number: id,
    repository_url: "https://api.github.com/repos/o/r",
    updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 200 - id)).toISOString(),
  });
  setOctokit({
    request: async (
      _route: string,
      params: { q: string; page: number; per_page: number }
    ) => {
      calls.push(params);
      return {
        data:
          params.q === "involves"
            ? {
                total_count: 101,
                items:
                  params.page === 1
                    ? Array.from({ length: 100 }, (_, i) => item(i + 1))
                    : [item(101)],
              }
            : { total_count: 2, items: [item(101), item(102)] },
      };
    },
    graphql: async (query: string) => {
      const matches = [
        ...query.matchAll(/pr(\d+):[\s\S]*?pullRequest\(number: (\d+)\)/g),
      ];
      batches.push(matches.length);
      return Object.fromEntries(
        matches.map(([, alias, number]) => [
          `pr${alias}`,
          {
            pullRequest: {
              number: Number(number),
              isReadByViewer: Number(number) <= 100,
              commits: { nodes: [] },
            },
          },
        ])
      );
    },
  } as never);
  const client = new QueryClient();
  try {
    const result = await client.fetchQuery(
      queries.prList(["involves", "team"], "all")
    );
    expect(
      calls.filter((call) => call.q === "involves").map((call) => call.page)
    ).toEqual([1, 2]);
    expect(calls.every((call) => call.per_page === 100)).toBe(true);
    expect(result.items.map((pr) => pr.id)).toEqual(
      Array.from({ length: 102 }, (_, i) => i + 1)
    );
    expect(
      result.items.filter((pr) => !pr.isReadByViewer).map((pr) => pr.id)
    ).toEqual([101, 102]);
    expect(batches).toEqual([30, 30, 30, 12]);
  } finally {
    client.clear();
  }
});

test("ordinary PR lists fetch only the requested page and use a separate cache entry", async () => {
  const calls: Array<{ page: number; per_page: number }> = [];
  setOctokit({
    request: async (
      _route: string,
      params: { page: number; per_page: number }
    ) => {
      calls.push(params);
      return { data: { total_count: 0, items: [] } };
    },
  } as never);
  const client = new QueryClient();
  try {
    await client.fetchQuery(queries.prList(["involves"], 2));
    await client.fetchQuery(queries.prList(["involves"], "all"));
    expect(calls.map(({ page, per_page }) => [page, per_page])).toEqual([
      [2, 30],
      [1, 100],
    ]);
  } finally {
    client.clear();
  }
});

test("comparison consumers share one response for files and commits", async () => {
  let requests = 0;
  setOctokit({
    request: async () => {
      requests++;
      return {
        data: { files: [{ filename: "a.ts" }], commits: [{ sha: "head" }] },
      };
    },
  } as never);
  const client = new QueryClient();
  try {
    const options = queries.comparison("comparison-test", "r", "base", "head");
    const [a, b] = await Promise.all([
      client.fetchQuery(options),
      client.fetchQuery(options),
    ]);
    expect(a.files.map((file) => file.filename)).toEqual(["a.ts"]);
    expect(b.commits.map((commit) => commit.sha)).toEqual(["head"]);
    await client.fetchQuery(options);
    expect(requests).toBe(1);
  } finally {
    client.clear();
  }
});

test("single commit cache retains files alongside parent metadata", async () => {
  let requests = 0;
  setOctokit({
    request: async () => {
      requests++;
      return {
        data: {
          files: [{ filename: "commit.ts" }],
          parents: [{ sha: "parent" }],
        },
      };
    },
  } as never);
  const client = new QueryClient();
  try {
    const options = queries.singleCommit("commit-cache-test", "r", "head");
    const first = await client.fetchQuery(options);
    const second = await client.fetchQuery(options);
    expect(first.files?.[0]?.filename).toBe("commit.ts");
    expect(second.parents[0]?.sha).toBe("parent");
    expect(requests).toBe(1);
  } finally {
    client.clear();
  }
});

test("single commit files include subsequent pages", async () => {
  const calls: number[] = [];
  setOctokit({
    request: async (_route: string, params: { page: number }) => {
      calls.push(params.page);
      return {
        data: {
          sha: "head",
          parents: [{ sha: "parent" }],
          files: Array.from(
            { length: params.page === 1 ? 100 : 1 },
            (_, i) => ({ filename: `${params.page}-${i}` })
          ),
        },
      };
    },
  } as never);
  const result = await queries.singleCommit("commit-pagination", "r", "head")
    .queryFn!({ signal: new AbortController().signal } as never);
  expect(result.files).toHaveLength(101);
  expect(result.parents[0]?.sha).toBe("parent");
  expect(calls).toEqual([1, 2]);
});

test("comparison identifies file lists at the GitHub limit as incomplete", async () => {
  setOctokit({
    request: async () => ({
      data: {
        files: Array.from({ length: 300 }, (_, i) => ({ filename: `${i}.ts` })),
        commits: [],
        total_commits: 0,
      },
    }),
  } as never);
  const result = await queries.comparison(
    "comparison-file-limit",
    "r",
    "base",
    "head"
  ).queryFn!({ signal: new AbortController().signal } as never);
  expect(result.filesComplete).toBe(false);
});

test("PR commits and comparison commits include subsequent pages", async () => {
  const calls: Array<Record<string, unknown>> = [];
  setOctokit({
    request: async (route: string, params: Record<string, unknown>) => {
      calls.push(params);
      const commits = Array.from(
        { length: params.page === 1 ? 100 : 1 },
        (_, i) => ({ sha: `${params.page}-${i}` })
      );
      return {
        data: route.includes("compare")
          ? {
              commits,
              total_commits: 101,
              files:
                params.page === 1 ? [{ filename: "first-page.ts" }] : undefined,
            }
          : commits,
      };
    },
  } as never);
  const context = {
    signal: new AbortController().signal,
    meta: undefined,
  } as never;
  const commits = await queries.pullRequestCommits("o", "r", 1).queryFn!(
    context
  );
  const comparison = await queries.comparison(
    "pagination-test",
    "r",
    "base",
    "head"
  ).queryFn!(context);
  expect(commits).toHaveLength(101);
  expect(comparison.commits).toHaveLength(101);
  expect(comparison.files[0]?.filename).toBe("first-page.ts");
  expect(calls.map((call) => call.page)).toEqual([1, 2, 1, 2]);
});

test("review threads paginate both the thread list and nested replies", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const pageInfo = (next: boolean) => ({
    hasNextPage: next,
    endCursor: next ? "next" : null,
  });
  const comment = (id: number) => ({
    databaseId: id,
    body: `comment ${id}`,
    pullRequestReview: { databaseId: 1, author: null },
  });
  const thread = (id: number) => ({
    id: `thread-${id}`,
    comments: {
      nodes:
        id === 0
          ? Array.from({ length: 100 }, (_, i) => comment(i))
          : [comment(id)],
      pageInfo: pageInfo(id === 0),
    },
  });
  setOctokit({
    graphql: async (query: string, params: Record<string, unknown>) => {
      calls.push(params);
      if (query.includes("$id:"))
        return {
          node: {
            comments: { nodes: [comment(100)], pageInfo: pageInfo(false) },
          },
        };
      return {
        repository: {
          viewerPermission: "WRITE",
          mergeCommitAllowed: true,
          squashMergeAllowed: true,
          rebaseMergeAllowed: true,
          mergeQueue: null,
          pullRequest: {
            viewerCanMergeAsAdmin: false,
            isInMergeQueue: false,
            baseRef: null,
            reviewThreads: {
              nodes: params.after
                ? [thread(101)]
                : Array.from({ length: 100 }, (_, i) => thread(i)),
              pageInfo: pageInfo(!params.after),
            },
          },
        },
      };
    },
  } as never);
  const result = await queries.reviewThreads("o", "r", 1).queryFn!({
    signal: new AbortController().signal,
    meta: undefined,
  } as never);
  expect(result.threads).toHaveLength(101);
  expect(result.threads[0]!.comments.nodes).toHaveLength(101);
  expect(result.threads[0]!.comments.nodes.at(-1)!.databaseId).toBe(100);
  expect(result.threads[0]!.pullRequestReview?.databaseId).toBe(1);
  expect(calls.map((call) => [call.after, call.id])).toEqual([
    [null, undefined],
    ["next", undefined],
    ["next", "thread-0"],
  ]);
});

test("pullRequestReviews paginates until a partial page", async () => {
  const page = (n: number) => Array.from({ length: n }, (_, i) => review(i));
  const calls: Array<Record<string, unknown>> = [];
  setOctokit({
    request: async (_route: string, params: Record<string, unknown>) => {
      calls.push(params);
      return {
        data: params.page === 1 ? page(100) : page(17),
      } as never;
    },
  } as never);

  const reviews = (await queries.pullRequestReviews("o", "r", 1).queryFn!({
    signal: new AbortController().signal,
    meta: undefined,
  } as never)) as Review[];

  expect(reviews).toHaveLength(117);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({ per_page: 100, page: 1 });
  expect(calls[1]).toMatchObject({ per_page: 100, page: 2 });
});

test("orgMembers paginates until a partial page", async () => {
  const member = (n: number) =>
    ({ login: `user-${n}`, avatar_url: "" }) as never;
  const calls: Array<Record<string, unknown>> = [];
  setOctokit({
    request: async (_route: string, params: Record<string, unknown>) => {
      calls.push(params);
      return {
        data:
          params.page === 1
            ? Array.from({ length: 100 }, (_, i) => member(i))
            : [member(100)],
      } as never;
    },
  } as never);

  const members = (await queries.orgMembers("o").queryFn!({
    signal: new AbortController().signal,
    meta: undefined,
  } as never)) as Array<{ login: string }>;

  expect(members).toHaveLength(101);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({ per_page: 100, page: 1 });
  expect(calls[1]).toMatchObject({ per_page: 100, page: 2 });
});

test("orgMembers returns empty for user-owned repos (404)", async () => {
  setOctokit({
    request: async () => {
      const e = new Error("Not Found") as Error & { status: number };
      e.status = 404;
      throw e;
    },
  } as never);

  const members = (await queries.orgMembers("o").queryFn!({
    signal: new AbortController().signal,
    meta: undefined,
  } as never)) as unknown[];

  expect(members).toEqual([]);
});
