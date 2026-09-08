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
