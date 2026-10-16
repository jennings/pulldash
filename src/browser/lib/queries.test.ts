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
