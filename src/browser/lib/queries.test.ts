import { test, expect } from "bun:test";
import { queries } from "./queries";
import { setOctokit } from "./github-client";
import type { Review } from "@/api/types";

const review = (id: number): Review =>
  ({
    id,
    user: { login: `user-${id}` },
    state: "APPROVED",
  }) as unknown as Review;

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
