import { useEffect } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { beginFetch, endFetch } from "../lib/fetch-progress";

export function GlobalProgress() {
  const initialLoads = useIsFetching({
    predicate: (q) =>
      q.state.fetchStatus === "fetching" && q.state.data === undefined,
  });
  const active = initialLoads > 0;
  useEffect(() => {
    if (!active) return;
    beginFetch();
    return () => endFetch();
  }, [active]);
  return null;
}
