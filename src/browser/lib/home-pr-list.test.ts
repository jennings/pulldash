import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { setOctokit } from "./github-client";
import { mergePRListPages, queries } from "./queries";
import { pollHomePRList, refreshHomePRList } from "./home-pr-list";

test("Home polling is opt-in and refreshes the selected page even while Home is hidden", async () => {
  const calls: number[] = [];
  setOctokit({
    request: async (_route: string, params: { page: number }) => {
      calls.push(params.page);
      return { data: { items: [], total_count: 0 } };
    },
  } as never);
  const client = new QueryClient();
  try {
    await pollHomePRList(client, ["involves"], 2, false, false);
    expect(calls).toEqual([]);
    await pollHomePRList(client, ["involves"], 2, false, true);
    await pollHomePRList(client, ["involves"], 2, false, true);
    expect(calls).toEqual([2, 2]);
    await pollHomePRList(client, ["involves"], 2, false, false);
    expect(calls).toEqual([2, 2]);
  } finally {
    client.clear();
  }
});

test("UPDATED background refresh fetches only the head and retains loaded pages and fresh PR versions", async () => {
  const calls: number[] = [];
  let updated = false;
  const item = (id: number) => ({
    id,
    title: updated ? "updated" : "original",
    updated_at: updated ? "2026-02-01" : "2026-01-01",
  });
  setOctokit({
    request: async (_route: string, params: { page: number }) => {
      calls.push(params.page);
      return {
        data: {
          total_count: 101,
          items:
            params.page === 1
              ? Array.from({ length: 100 }, (_, i) =>
                  item(updated && i === 0 ? 101 : i + 1)
                )
              : [item(101)],
        },
      };
    },
  } as never);
  const client = new QueryClient();
  try {
    const options = queries.prListInfinite(["involves"]);
    const initial = await client.fetchInfiniteQuery({ ...options, pages: 2 });
    expect(calls).toEqual([1, 2]);
    updated = true;
    await pollHomePRList(client, ["involves"], 1, true, true);
    const refreshed = client.getQueryData(options.queryKey)!;
    expect(calls).toEqual([1, 2, 1]);
    expect(refreshed.pages).toHaveLength(2);
    expect(refreshed.pages[1]).toBe(initial.pages[1]);
    expect(refreshed.pageParams).toEqual(initial.pageParams);
    expect(
      mergePRListPages(refreshed.pages).find((pr) => pr.id === 101)?.title
    ).toBe("updated");
  } finally {
    client.clear();
  }
});

test("rate-limited Home polling keeps cached results, pauses automatic requests, and allows manual recovery", async () => {
  let limited = false;
  let calls = 0;
  const rateLimit = Object.assign(new Error("API rate limit exceeded"), {
    status: 403,
  });
  setOctokit({
    request: async () => {
      calls++;
      if (limited) throw rateLimit;
      return {
        data: { items: [{ id: 1, updated_at: "2026-01-01" }], total_count: 1 },
      };
    },
  } as never);
  const client = new QueryClient();
  try {
    const options = queries.prListInfinite(["involves"]);
    const initial = await client.fetchInfiniteQuery(options);
    limited = true;
    await expect(
      pollHomePRList(client, ["involves"], 1, true, true)
    ).rejects.toBe(rateLimit);
    expect(client.getQueryData(options.queryKey)?.pages).toEqual(initial.pages);
    await pollHomePRList(client, ["involves"], 1, true, true);
    expect(calls).toBe(2);
    limited = false;
    await refreshHomePRList(client, ["involves"], 1, true);
    expect(client.getQueryState(options.queryKey)?.error).toBeNull();
    expect(calls).toBe(3);
  } finally {
    client.clear();
  }
});
