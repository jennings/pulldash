import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { usePRReviewStore, type OverviewTab } from ".";

type Tab = OverviewTab | "changes";

const OVERVIEW_TABS: ReadonlyArray<OverviewTab> = [
  "conversation",
  "commits",
  "checks",
];

function isOverviewTab(tab: string | undefined): tab is OverviewTab {
  return tab !== undefined && OVERVIEW_TABS.includes(tab as OverviewTab);
}

function parseTab(segment: string | undefined): Tab {
  if (segment === "changes") return "changes";
  if (isOverviewTab(segment)) return segment;
  return "conversation";
}

/**
 * Sync the PR-review store and the URL path so that each tab of a PR
 * (overview/conversation, commits, checks, changes) has its own route.
 *
 * The URL path is the source of truth for *which tab is showing*; the
 * URL hash continues to encode within-tab state (selected file, focused
 * line, version selectors, etc.).
 */
export function useRouteNavigation() {
  const store = usePRReviewStore();
  const navigate = useNavigate();
  const params = useParams<{
    owner: string;
    repo: string;
    number: string;
    tab?: string;
  }>();

  const owner = params.owner;
  const repo = params.repo;
  const number = params.number;
  const routeTab = parseTab(params.tab);

  // URL → store
  useEffect(() => {
    if (routeTab === "changes") {
      // Leaving overview; selectedFile may already be set from the hash.
      // If not, defer to selectFirstFile to pick a sensible default once
      // files load.
      const state = store.getSnapshot();
      if (state.showOverview) {
        if (state.selectedFile) {
          store.selectFile(state.selectedFile);
        } else if (state.files.length > 0) {
          store.selectFile(state.files[0].filename);
        }
      }
    } else {
      // Overview sub-tab.
      store.setOverviewActiveTab(routeTab);
    }
  }, [routeTab, store]);

  // Store → URL
  useEffect(() => {
    if (!owner || !repo || !number) return;
    const basePath = `/${owner}/${repo}/pull/${number}`;

    const updatePath = () => {
      const state = store.getSnapshot();
      const expectedTab: Tab = state.showOverview
        ? state.overviewActiveTab
        : "changes";

      const expectedPath =
        expectedTab === "conversation"
          ? basePath
          : `${basePath}/${expectedTab}`;

      if (window.location.pathname === expectedPath) return;

      navigate(expectedPath + window.location.hash, { replace: true });
    };

    // Run once on mount in case the store and URL are out of sync (e.g. a
    // file was selected from a hash on a /commits route).
    updatePath();

    return store.subscribe(updatePath);
  }, [store, navigate, owner, repo, number]);
}
