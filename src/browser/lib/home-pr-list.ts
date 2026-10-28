import type { QueryClient } from "@tanstack/react-query";
import { queries } from "./queries";

export async function refreshHomePRList(
  client: QueryClient,
  queryStrings: string[],
  page: number,
  updatedOnly: boolean
) {
  if (!updatedOnly) {
    await client.fetchQuery({
      ...queries.prList(queryStrings, page),
      staleTime: 0,
    });
    return;
  }
  const options = queries.prListInfinite(queryStrings);
  const previous = client.getQueryData(options.queryKey);
  // Refetch only the head; replaying all loaded pages can exhaust search limits.
  const head = await client.fetchInfiniteQuery({
    ...options,
    pages: 1,
    staleTime: 0,
  });
  if (previous && previous.pages.length > 1) {
    client.setQueryData(options.queryKey, {
      pages: [...head.pages, ...previous.pages.slice(1)],
      pageParams: [...head.pageParams, ...previous.pageParams.slice(1)],
    });
  }
}

export async function pollHomePRList(
  client: QueryClient,
  queryStrings: string[],
  page: number,
  updatedOnly: boolean,
  notificationsEnabled: boolean
) {
  if (!notificationsEnabled) return;
  const key = updatedOnly
    ? queries.prListInfinite(queryStrings).queryKey
    : queries.prList(queryStrings, page).queryKey;
  const state = client.getQueryState(key);
  if (state?.fetchStatus === "fetching" || state?.error) return;
  await refreshHomePRList(client, queryStrings, page, updatedOnly);
}
