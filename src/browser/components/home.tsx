import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queries } from "../lib/queries";
import {
  Search,
  GitPullRequest,
  Loader2,
  Star,
  X,
  Plus,
  FileCode,
  Check,
  GitMerge,
  ChevronDown,
  Eye,
  EyeOff,
  AtSign,
  User,
  Users,
  RefreshCw,
  Circle,
  CheckCircle2,
  XCircle,
  AlertCircle,
  MessageSquare,
  Clock,
  Pencil,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { cn } from "../cn";
import { Skeleton } from "../ui/skeleton";
import { UserHoverCard } from "../ui/user-hover-card";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "../ui/pagination";
import {
  useOpenPRReviewTab,
  useTabContext,
  type TabStatus,
} from "../contexts/tabs";
import {
  useGitHubStore,
  useGitHubReady,
  getCachedTeams,
  subscribeTeams,
  type PRSearchResult,
} from "../contexts/github";
import { getLastViewed, setLastViewed } from "../lib/waiting-prs";
import {
  getEnabled as notifsEnabled,
  subscribeEnabled as subscribeNotifsEnabled,
} from "../lib/notifications";
import { useAuth } from "../contexts/auth";
import { getTimeAgo } from "../lib/dates";

// ============================================================================
// Types
// ============================================================================

interface SearchResult {
  id: number;
  full_name: string;
  description: string | null;
  stargazers_count?: number;
  forks_count?: number;
  updated_at?: string;
  owner: {
    login: string;
    avatar_url: string;
  } | null;
}

// Filter mode type
type FilterMode =
  | "review-requested"
  | "reviewed"
  | "authored"
  | "authored-by"
  | "involves"
  | "all";

// Special constant for "All Repos" global filter
const ALL_REPOS_KEY = "__all_repos__";

// Repository with its filter mode
interface RepoFilter {
  name: string;
  mode: FilterMode;
  authoredBy?: string; // Username for "authored-by" filter mode
  enabled?: boolean; // Whether the filter is active (defaults to true)
}

type StateFilter = "open" | "closed" | "all";

// Filter configuration for a single group (the working values consumed by the UI).
// Note: the open/closed/all state filter and the Updated/Stalled toggles are
// deliberately NOT part of a group — they're orthogonal, session-level filters.
interface FilterConfig {
  repos: RepoFilter[];
}

// A named, persisted collection of filter values that the user can switch between.
interface FilterGroup extends FilterConfig {
  id: string;
  name: string;
}

// Full localStorage shape backing the filter UI.
interface FilterGroupsStorage {
  groups: FilterGroup[];
  selectedGroupId: string;
}

// Check if a filter is the special "All Repos" filter
function isAllReposFilter(filter: RepoFilter): boolean {
  return filter.name === ALL_REPOS_KEY;
}

// ============================================================================
// Storage Helpers
// ============================================================================

const STORAGE_KEY = "pulldash_filter_groups";
const LEGACY_STORAGE_KEY = "pulldash_filter_config";
const STATE_STORAGE_KEY = "pulldash_filter_state";
const DEFAULT_GROUP_NAME = "Default";
const DEFAULT_STATE_FILTER: StateFilter = "open";

const DEFAULT_CONFIG: FilterConfig = {
  // Default to showing review requests across all repos
  repos: [{ name: ALL_REPOS_KEY, mode: "review-requested" }],
};

function getStateFilter(): StateFilter {
  try {
    const stored = localStorage.getItem(STATE_STORAGE_KEY);
    if (stored === "open" || stored === "closed" || stored === "all") {
      return stored;
    }
  } catch {
    // ignore
  }
  return DEFAULT_STATE_FILTER;
}

function saveStateFilter(state: StateFilter): void {
  try {
    localStorage.setItem(STATE_STORAGE_KEY, state);
  } catch {
    // ignore
  }
}

function newGroupId(): string {
  return crypto.randomUUID();
}

// Read the legacy single-config shape and apply its historical migrations.
// If the legacy record had a `state` field, promote it to the standalone
// state-filter key. Returns just the group-scoped fields, or null if the
// legacy key is absent or unparseable.
function readLegacyFilterConfig(): FilterConfig | null {
  try {
    const stored = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    // Migration: convert old string[] repos to RepoFilter[]
    if (
      parsed.repos &&
      parsed.repos.length > 0 &&
      typeof parsed.repos[0] === "string"
    ) {
      parsed.repos = parsed.repos.map((name: string) => ({
        name,
        mode: parsed.mode || "review-requested",
      }));
      delete parsed.mode;
    }
    // Migration: if user has empty repos, give them the new default (All Repos)
    if (parsed.repos && parsed.repos.length === 0) {
      parsed.repos = DEFAULT_CONFIG.repos;
    }
    // Migration: promote the legacy `state` field to its own key.
    if (
      parsed.state === "open" ||
      parsed.state === "closed" ||
      parsed.state === "all"
    ) {
      saveStateFilter(parsed.state);
    }
    return { repos: parsed.repos ?? DEFAULT_CONFIG.repos };
  } catch {
    return null;
  }
}

function makeDefaultStorage(config: FilterConfig): FilterGroupsStorage {
  const group: FilterGroup = {
    id: newGroupId(),
    name: DEFAULT_GROUP_NAME,
    repos: config.repos,
  };
  return { groups: [group], selectedGroupId: group.id };
}

function getFilterGroupsStorage(): FilterGroupsStorage {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<FilterGroupsStorage>;
      if (
        parsed &&
        Array.isArray(parsed.groups) &&
        parsed.groups.length > 0 &&
        typeof parsed.selectedGroupId === "string" &&
        parsed.groups.some((g) => g.id === parsed.selectedGroupId)
      ) {
        return parsed as FilterGroupsStorage;
      }
    }
  } catch {
    // fall through to migration
  }

  const legacy = readLegacyFilterConfig();
  const storage = makeDefaultStorage(legacy ?? DEFAULT_CONFIG);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
    if (legacy !== null) {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
  return storage;
}

function saveFilterGroupsStorage(storage: FilterGroupsStorage): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
}

// Normalize for dirty comparison: default `enabled` to true, `authoredBy` to null,
// so a toggled-then-untoggled repo equals its pristine form.
function normalizeConfig(c: FilterConfig): string {
  return JSON.stringify({
    repos: c.repos.map((r) => ({
      name: r.name,
      mode: r.mode,
      authoredBy: r.authoredBy ?? null,
      enabled: r.enabled !== false,
    })),
  });
}

function configsEqual(a: FilterConfig, b: FilterConfig): boolean {
  return normalizeConfig(a) === normalizeConfig(b);
}

function extractConfig(group: FilterGroup): FilterConfig {
  return { repos: group.repos };
}
// ============================================================================
// Query Builder
// ============================================================================

function getModeFilter(mode: FilterMode, authoredBy?: string): string {
  switch (mode) {
    case "review-requested":
      return "review-requested:@me";
    case "reviewed":
      return "reviewed-by:@me";
    case "authored":
      return "author:@me";
    case "authored-by":
      return authoredBy ? `author:${authoredBy}` : "";
    case "involves":
      return "involves:@me";
    default:
      return "";
  }
}

// Build queries grouped by mode (GitHub doesn't support per-repo qualifiers with OR)
// Multiple repo: qualifiers act as OR, but user filters apply to all repos
function buildSearchQueries(
  config: FilterConfig,
  state: StateFilter,
  stalledThreshold?: string
): string[] {
  // Filter out disabled repos (enabled defaults to true if not specified)
  const enabledRepos = config.repos.filter((r) => r.enabled !== false);

  if (enabledRepos.length === 0) {
    return [];
  }

  const stateFilter =
    state === "open" ? "is:open" : state === "closed" ? "is:closed" : "";

  const queries: string[] = [];

  // Server-side stalled filter: only PRs updated before this date
  const stalledFilter = stalledThreshold
    ? `updated:<${stalledThreshold}`
    : undefined;

  // Separate "All Repos" filters from specific repo filters
  const allReposFilters = enabledRepos.filter(isAllReposFilter);
  const specificRepos = enabledRepos.filter((r) => !isAllReposFilter(r));

  // Handle "All Repos" global filters (one query per mode)
  for (const filter of allReposFilters) {
    const parts = ["is:pr", "archived:false"];
    if (stateFilter) parts.push(stateFilter);
    if (stalledFilter) parts.push(stalledFilter);
    const modeFilter = getModeFilter(filter.mode, filter.authoredBy);
    if (modeFilter) parts.push(modeFilter);
    // Note: "all" mode on All Repos would be too broad, so we skip it
    // Also skip "authored-by" without a username
    if (
      filter.mode !== "all" &&
      !(filter.mode === "authored-by" && !filter.authoredBy)
    ) {
      queries.push(parts.join(" "));
    }

    if (filter.mode === "involves") {
      const teams = getCachedTeams();
      if (teams.length > 0) {
        const teamParts = ["is:pr", "archived:false"];
        if (stateFilter) teamParts.push(stateFilter);
        if (stalledFilter) teamParts.push(stalledFilter);
        for (const team of teams) {
          teamParts.push(`team-review-requested:${team.org}/${team.slug}`);
        }
        queries.push(teamParts.join(" "));
      }
    }
  }

  // Group specific repos by mode+authoredBy (for authored-by, different authors need separate queries)
  if (specificRepos.length > 0) {
    // Use a composite key: mode + authoredBy for authored-by mode
    const byModeKey = new Map<
      string,
      { mode: FilterMode; authoredBy?: string; repos: string[] }
    >();
    for (const repo of specificRepos) {
      const key =
        repo.mode === "authored-by"
          ? `${repo.mode}:${repo.authoredBy || ""}`
          : repo.mode;
      const existing = byModeKey.get(key);
      if (existing) {
        existing.repos.push(repo.name);
      } else {
        byModeKey.set(key, {
          mode: repo.mode,
          authoredBy: repo.authoredBy,
          repos: [repo.name],
        });
      }
    }

    for (const [, { mode, authoredBy, repos }] of byModeKey) {
      // Skip authored-by without a username
      if (mode === "authored-by" && !authoredBy) continue;

      const parts = ["is:pr", "archived:false"];
      if (stateFilter) parts.push(stateFilter);
      if (stalledFilter) parts.push(stalledFilter);
      // Multiple repo: qualifiers act as OR
      parts.push(...repos.map((r) => `repo:${r}`));
      const modeFilter = getModeFilter(mode, authoredBy);
      if (modeFilter) parts.push(modeFilter);
      queries.push(parts.join(" "));

      if (mode === "involves") {
        const teams = getCachedTeams();
        if (teams.length > 0) {
          const teamParts = ["is:pr", "archived:false"];
          if (stateFilter) teamParts.push(stateFilter);
          if (stalledFilter) teamParts.push(stalledFilter);
          teamParts.push(...repos.map((r) => `repo:${r}`));
          for (const team of teams) {
            teamParts.push(`team-review-requested:${team.org}/${team.slug}`);
          }
          queries.push(teamParts.join(" "));
        }
      }
    }
  }

  return queries;
}

// ============================================================================
// Helpers
// ============================================================================

function extractRepoFromUrl(
  url: string
): { owner: string; repo: string } | null {
  const match = url.match(/repos\/([^/]+)\/([^/]+)/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

// ============================================================================
// Mode Options
// ============================================================================

const MODE_OPTIONS = [
  {
    value: "review-requested",
    label: "Review Requests",
    icon: AtSign,
    description: "PRs where you're requested as reviewer",
  },
  {
    value: "reviewed",
    label: "Reviewed",
    icon: MessageSquare,
    description: "PRs you've already reviewed",
  },
  {
    value: "authored",
    label: "My PRs",
    icon: User,
    description: "PRs you authored",
  },
  {
    value: "authored-by",
    label: "Created by User",
    icon: User,
    description: "PRs created by a specific user",
    hasInput: true,
  },
  {
    value: "involves",
    label: "Involves Me",
    icon: Users,
    description: "PRs that mention or involve you",
  },
  {
    value: "all",
    label: "All PRs",
    icon: GitPullRequest,
    description: "All PRs in selected repos",
  },
] as const;

const STATE_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
] as const;

// ============================================================================
// Main Component
// ============================================================================

export function Home() {
  const openPRReviewTab = useOpenPRReviewTab();
  const { ready: githubReady, error: githubError } = useGitHubReady();
  const github = useGitHubStore();
  const { isAuthenticated } = useAuth();

  const queryClient = useQueryClient();

  // Filter config: `filterStorage` mirrors localStorage (groups + selected id).
  // `config` is the working state — edits since the last save/switch.
  // `savedConfig` is derived from the selected group; `isDirty` compares them.
  const [filterStorage, setFilterStorage] = useState<FilterGroupsStorage>(
    getFilterGroupsStorage
  );
  const [config, setConfig] = useState<FilterConfig>(() => {
    const g =
      filterStorage.groups.find(
        (x) => x.id === filterStorage.selectedGroupId
      ) ?? filterStorage.groups[0];
    return extractConfig(g);
  });
  const selectedGroup =
    filterStorage.groups.find((g) => g.id === filterStorage.selectedGroupId) ??
    filterStorage.groups[0];
  const savedConfig = extractConfig(selectedGroup);
  const isDirty = !configsEqual(config, savedConfig);

  // Save-new inline input state (React-only, resets on refresh)
  const [isNamingGroup, setIsNamingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupNameError, setNewGroupNameError] = useState<string | null>(
    null
  );

  const handleSaveGroup = useCallback(() => {
    setFilterStorage((prev) => {
      const next: FilterGroupsStorage = {
        ...prev,
        groups: prev.groups.map((g) =>
          g.id === prev.selectedGroupId ? { ...g, repos: config.repos } : g
        ),
      };
      saveFilterGroupsStorage(next);
      return next;
    });
  }, [config]);

  const handleSaveNewGroup = useCallback(
    (rawName: string): boolean => {
      const trimmed = rawName.trim();
      if (!trimmed) {
        setNewGroupNameError("Name is required");
        return false;
      }
      const lower = trimmed.toLowerCase();
      if (filterStorage.groups.some((g) => g.name.toLowerCase() === lower)) {
        setNewGroupNameError("Name already in use");
        return false;
      }
      const newGroup: FilterGroup = {
        id: newGroupId(),
        name: trimmed,
        repos: config.repos,
      };
      const next: FilterGroupsStorage = {
        groups: [...filterStorage.groups, newGroup],
        selectedGroupId: newGroup.id,
      };
      saveFilterGroupsStorage(next);
      setFilterStorage(next);
      setIsNamingGroup(false);
      setNewGroupName("");
      setNewGroupNameError(null);
      return true;
    },
    [config, filterStorage]
  );

  const handleSelectGroup = useCallback(
    (id: string) => {
      if (id === filterStorage.selectedGroupId) return;
      const target = filterStorage.groups.find((g) => g.id === id);
      if (!target) return;
      const next: FilterGroupsStorage = {
        ...filterStorage,
        selectedGroupId: target.id,
      };
      saveFilterGroupsStorage(next);
      setFilterStorage(next);
      setConfig(extractConfig(target));
      setIsNamingGroup(false);
      setNewGroupName("");
      setNewGroupNameError(null);
    },
    [filterStorage]
  );

  // State filter (open/closed/all) is orthogonal to filter groups — persisted
  // in its own localStorage key so it survives group switches and refreshes.
  const [stateFilter, setStateFilter] = useState<StateFilter>(getStateFilter);
  useEffect(() => {
    saveStateFilter(stateFilter);
  }, [stateFilter]);

  // Edit-group state. `groupToEdit` doubles as the edit dialog's open flag;
  // `editName` / `editNameError` back the dialog's rename input.
  const [groupToEdit, setGroupToEdit] = useState<FilterGroup | null>(null);
  const [editName, setEditName] = useState("");
  const [editNameError, setEditNameError] = useState<string | null>(null);
  const [selectorOpen, setSelectorOpen] = useState(false);

  const openEditDialog = useCallback((g: FilterGroup) => {
    setGroupToEdit(g);
    setEditName(g.name);
    setEditNameError(null);
  }, []);

  const closeEditDialog = useCallback(() => {
    setGroupToEdit(null);
    setEditName("");
    setEditNameError(null);
  }, []);

  const handleRenameGroup = useCallback(
    (id: string, rawName: string): boolean => {
      const trimmed = rawName.trim();
      if (!trimmed) {
        setEditNameError("Name is required");
        return false;
      }
      const lower = trimmed.toLowerCase();
      if (
        filterStorage.groups.some(
          (g) => g.id !== id && g.name.toLowerCase() === lower
        )
      ) {
        setEditNameError("Name already in use");
        return false;
      }
      const next: FilterGroupsStorage = {
        ...filterStorage,
        groups: filterStorage.groups.map((g) =>
          g.id === id ? { ...g, name: trimmed } : g
        ),
      };
      saveFilterGroupsStorage(next);
      setFilterStorage(next);
      closeEditDialog();
      return true;
    },
    [filterStorage, closeEditDialog]
  );

  const handleDeleteGroup = useCallback(
    (id: string) => {
      const remaining = filterStorage.groups.filter((g) => g.id !== id);
      if (remaining.length === 0) return; // guard: last group is structurally undeletable
      let selectedId = filterStorage.selectedGroupId;
      let loadTarget: FilterGroup | null = null;
      if (id === filterStorage.selectedGroupId) {
        // Fall back to the alphabetically-first (case-insensitive) remaining group.
        const sorted = [...remaining].sort((a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase())
        );
        loadTarget = sorted[0];
        selectedId = loadTarget.id;
      }
      const next: FilterGroupsStorage = {
        groups: remaining,
        selectedGroupId: selectedId,
      };
      saveFilterGroupsStorage(next);
      setFilterStorage(next);
      if (loadTarget) {
        setConfig(extractConfig(loadTarget));
      }
      closeEditDialog();
    },
    [filterStorage, closeEditDialog]
  );

  // Search for adding repos
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  // Pagination
  const [page, setPage] = useState(1);

  // Client-side filter for UPDATED PRs, persisted across reloads
  const [showUpdatedOnly, setShowUpdatedOnly] = useState(
    () => localStorage.getItem("pulldash_show_updated_only") === "true"
  );
  useEffect(() => {
    localStorage.setItem(
      "pulldash_show_updated_only",
      showUpdatedOnly ? "true" : ""
    );
  }, [showUpdatedOnly]);

  const STALLED_DAYS = 14;
  const [showStalledOnly, setShowStalledOnly] = useState(false);

  const perPage = 30;

  // Re-memoize when teams finish loading (async after ready) so team-review-requested: queries appear
  const [teamsKey, setTeamsKey] = useState(0);
  useEffect(() => subscribeTeams(() => setTeamsKey((k) => k + 1)), []);

  // Server-side stalled filter: date threshold 14 days ago
  const stalledThreshold = useMemo(() => {
    if (!showStalledOnly) return undefined;
    const d = new Date(Date.now() - STALLED_DAYS * 86400000);
    return d.toISOString().slice(0, 10);
  }, [showStalledOnly]);

  // Build queries from config (one per mode group)
  const searchQueries = useMemo(
    () => buildSearchQueries(config, stateFilter, stalledThreshold),
    [config, stateFilter, teamsKey, stalledThreshold]
  );

  // Reset page when the visible filter set changes
  useEffect(() => {
    setPage(1);
  }, [config.repos, stateFilter]);

  const notificationsEnabled = useSyncExternalStore(
    subscribeNotifsEnabled,
    notifsEnabled,
    notifsEnabled
  );

  // PR list via React Query
  const {
    data: prListData,
    isFetching: loadingPrs,
    isPending: prListPending,
    dataUpdatedAt,
  } = useQuery({
    ...queries.prList(searchQueries, page, perPage),
    enabled: githubReady,
    refetchInterval: 60_000,
    refetchIntervalInBackground: notificationsEnabled,
  });

  const refreshPRList = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["pr-list"] });
  }, [queryClient]);

  // Convenience accessors
  const prs = prListData?.items ?? [];
  const totalCount = prListData?.totalCount ?? 0;

  // Client-side filter for UPDATED PRs
  const filteredPrs = useMemo(() => {
    if (!showUpdatedOnly) return prs;
    return prs.filter((pr) => {
      const info = extractRepoFromUrl(pr.repository_url);
      if (!info) return false;
      const prId = `${info.owner}/${info.repo}#${pr.number}`;
      const viewerLastViewedAt = getLastViewed(prId);
      const baselines: string[] = [];
      if (pr.viewerLastReviewAt) baselines.push(pr.viewerLastReviewAt);
      if (viewerLastViewedAt) baselines.push(viewerLastViewedAt);
      if (pr.isReadByViewer && pr.updated_at) baselines.push(pr.updated_at);
      if (baselines.length === 0) return true;
      const baseline = baselines.reduce((a, b) => (a > b ? a : b));
      return pr.updated_at ? pr.updated_at > baseline : false;
    });
  }, [prs, showUpdatedOnly]);

  // Seed the open/queued/merged dot for PR tabs that don't yet have a status,
  // using the home list's enrichment so we don't pay an extra request per tab.
  // pr-review's useSyncTabStatus is authoritative once the user activates a
  // tab — we deliberately don't overwrite an existing status here, since
  // search enrichment is staler than usePRChecks and lacks `mergeable`.
  const { tabs, updateTabStatus } = useTabContext();
  useEffect(() => {
    if (prs.length === 0) return;

    const prByKey = new Map<string, PRSearchResult>();
    for (const pr of prs) {
      const repoInfo = extractRepoFromUrl(pr.repository_url ?? "");
      if (!repoInfo) continue;
      const key = `${repoInfo.owner.toLowerCase()}/${repoInfo.repo.toLowerCase()}/${pr.number}`;
      prByKey.set(key, pr);
    }

    for (const tab of tabs) {
      if (
        tab.type !== "pr-review" ||
        !tab.owner ||
        !tab.repo ||
        tab.number === undefined ||
        tab.status !== undefined
      ) {
        continue;
      }
      const key = `${tab.owner.toLowerCase()}/${tab.repo.toLowerCase()}/${tab.number}`;
      const pr = prByKey.get(key);
      if (!pr) continue;

      const isMerged = pr.pull_request?.merged_at != null;
      const isClosed = !isMerged && pr.state === "closed";
      const state: TabStatus["state"] = isMerged
        ? "merged"
        : isClosed
          ? "closed"
          : pr.draft
            ? "draft"
            : "open";

      updateTabStatus(tab.id, {
        state,
        checks: pr.ciStatus ?? "none",
        mergeable: null,
        inMergeQueue: pr.inMergeQueue ?? false,
      });
    }
  }, [prs, tabs, updateTabStatus]);

  // Search repositories with debounce
  useEffect(() => {
    if (!github || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const timeout = setTimeout(async () => {
      setSearching(true);
      try {
        let query = searchQuery.trim();
        const slashMatch = query.match(/^([^/\s]+)\/([^/\s]+)$/);
        if (slashMatch) {
          const [, org, name] = slashMatch;
          query = `org:${org} ${name} fork:true`;
        }

        const data = await github.searchRepos(query);
        setSearchResults(data.items || []);
      } catch (e) {
        console.error("Failed to search repos:", e);
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [github, searchQuery]);

  const handleAddRepo = useCallback((fullName: string) => {
    setConfig((prev) => {
      if (prev.repos.some((r) => r.name === fullName)) return prev;
      return {
        ...prev,
        repos: [...prev.repos, { name: fullName, mode: "review-requested" }],
      };
    });
    setSearchQuery("");
    setSearchResults([]);
  }, []);

  const handleRemoveRepo = useCallback((repoName: string) => {
    setConfig((prev) => ({
      ...prev,
      repos: prev.repos.filter((r) => r.name !== repoName),
    }));
  }, []);

  const handleRepoModeChange = useCallback(
    (repoName: string, mode: FilterMode, authoredBy?: string) => {
      setConfig((prev) => ({
        ...prev,
        repos: prev.repos.map((r) =>
          r.name === repoName ? { ...r, mode, authoredBy } : r
        ),
      }));
    },
    []
  );

  const handleToggleRepo = useCallback(
    (repoName: string, shiftKey: boolean) => {
      setConfig((prev) => {
        const target = prev.repos.find((r) => r.name === repoName);
        const isEnabled = target ? target.enabled !== false : true;
        if (shiftKey) {
          if (isEnabled) {
            const isOnlyEnabled = prev.repos.every(
              (r) => r.name === repoName || r.enabled === false
            );
            if (isOnlyEnabled) {
              // Already the only enabled filter — re-enable all
              return {
                ...prev,
                repos: prev.repos.map((r) => ({ ...r, enabled: true })),
              };
            }
            // Shift+click on enabled: disable all others, keep this one enabled
            return {
              ...prev,
              repos: prev.repos.map((r) =>
                r.name === repoName
                  ? { ...r, enabled: true }
                  : { ...r, enabled: false }
              ),
            };
          } else {
            // Shift+click on disabled: isolate — enable this one, disable others
            return {
              ...prev,
              repos: prev.repos.map((r) =>
                r.name === repoName
                  ? { ...r, enabled: true }
                  : { ...r, enabled: false }
              ),
            };
          }
        }
        return {
          ...prev,
          repos: prev.repos.map((r) =>
            r.name === repoName ? { ...r, enabled: r.enabled === false } : r
          ),
        };
      });
    },
    []
  );

  const handleStateChange = useCallback((state: StateFilter) => {
    setStateFilter(state);
  }, []);

  const handleOpenPR = useCallback(
    (owner: string, repo: string, number: number, title: string) => {
      setLastViewed(`${owner}/${repo}#${number}`);
      openPRReviewTab(owner, repo, number, title);
    },
    [openPRReviewTab]
  );

  const totalPages = Math.max(
    1,
    Math.ceil((showUpdatedOnly ? filteredPrs.length : totalCount) / perPage)
  );

  // Track which repo dropdown is open
  const [openRepoDropdown, setOpenRepoDropdown] = useState<string | null>(null);
  const [repoDropdownPosition, setRepoDropdownPosition] = useState({
    top: 0,
    left: 0,
  });
  // Track author input for "authored-by" mode
  const [authoredByInput, setAuthoredByInput] = useState<string>("");
  const [showAuthoredByInput, setShowAuthoredByInput] = useState<string | null>(
    null
  );
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [addRepoButtonRef, setAddRepoButtonRef] =
    useState<HTMLButtonElement | null>(null);
  const [addRepoDropdownPosition, setAddRepoDropdownPosition] = useState({
    top: 0,
    right: 0,
  });

  // Show loading/error state while GitHub client initializes
  if (!githubReady) {
    if (githubError) {
      return (
        <div className="h-full bg-background flex items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <p className="text-destructive font-medium">
              Failed to connect to GitHub
            </p>
            <p className="text-sm text-muted-foreground">{githubError}</p>
          </div>
        </div>
      );
    }
    return <HomeLoadingSkeleton />;
  }

  const sortedGroups = [...filterStorage.groups].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  );
  const showGroupSelector = filterStorage.groups.length > 1;

  const cancelNaming = () => {
    setIsNamingGroup(false);
    setNewGroupName("");
    setNewGroupNameError(null);
  };

  return (
    <div className="h-full bg-background flex flex-col overflow-hidden">
      <Dialog
        open={groupToEdit !== null}
        onOpenChange={(open) => {
          if (!open) closeEditDialog();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit filter group</DialogTitle>
            <DialogDescription>
              Rename this filter group, or delete it permanently.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <label
              htmlFor="edit-group-name"
              className="text-xs font-medium text-muted-foreground"
            >
              Name
            </label>
            <input
              id="edit-group-name"
              type="text"
              value={editName}
              autoFocus
              onChange={(e) => {
                setEditName(e.target.value);
                if (editNameError) setEditNameError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && groupToEdit) {
                  e.preventDefault();
                  handleRenameGroup(groupToEdit.id, editName);
                }
              }}
              className={cn(
                "h-8 px-2 rounded-md border bg-muted/50 text-sm focus:outline-none focus:ring-2 focus:ring-ring",
                editNameError
                  ? "border-destructive focus:ring-destructive/40"
                  : "border-border focus:border-transparent"
              )}
            />
            {editNameError && (
              <span className="text-xs text-destructive">{editNameError}</span>
            )}
          </div>
          <DialogFooter className="sm:justify-between">
            <Button
              variant="destructive"
              onClick={() => groupToEdit && handleDeleteGroup(groupToEdit.id)}
            >
              Delete
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={closeEditDialog}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  groupToEdit && handleRenameGroup(groupToEdit.id, editName)
                }
              >
                Save
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Filter Bar */}
      <div className="border-b border-border px-2 sm:px-4 py-2 shrink-0 bg-card/30">
        {/* Mobile: horizontal scroll, Desktop: wrap */}
        <div className="flex items-center gap-2 sm:gap-3 overflow-x-auto hide-scrollbar">
          {/* Group selector: only when there is more than one group. */}
          {showGroupSelector && (
            <DropdownMenu open={selectorOpen} onOpenChange={setSelectorOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded hover:bg-muted/50 transition-colors max-w-[14rem] shrink-0"
                  aria-label="Select filter group"
                >
                  <span className="truncate">{selectedGroup.name}</span>
                  <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[14rem]">
                {sortedGroups.map((g) => {
                  const isSelected = g.id === filterStorage.selectedGroupId;
                  return (
                    <DropdownMenuItem
                      key={g.id}
                      onSelect={() => handleSelectGroup(g.id)}
                      className={cn(
                        "group/row flex items-center gap-2",
                        isSelected && "font-medium"
                      )}
                    >
                      <span className="w-3 shrink-0 flex justify-center">
                        {isSelected && (
                          <Check className="w-3 h-3 text-muted-foreground" />
                        )}
                      </span>
                      <span className="truncate flex-1">{g.name}</span>
                      <button
                        type="button"
                        aria-label={`Edit filter group ${g.name}`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectorOpen(false);
                          openEditDialog(g);
                        }}
                        className="opacity-0 group-hover/row:opacity-100 focus:opacity-100 focus:outline-none rounded p-0.5 hover:bg-muted shrink-0"
                      >
                        <Pencil className="w-3 h-3 text-muted-foreground hover:text-foreground" />
                      </button>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Divider between the group selector and the repo filters.
              Suppressed when there is only one group (no selector). */}
          {showGroupSelector && (
            <div aria-hidden className="h-4 w-px bg-border shrink-0" />
          )}

          {/* Repo Chips with Mode Dropdowns */}
          <div className="flex items-center gap-1.5 shrink-0">
            {config.repos.length === 0 && (
              <span className="text-xs text-muted-foreground">
                Add a filter to get started →
              </span>
            )}
            {config.repos.map((repo) => {
              const isAllRepos = isAllReposFilter(repo);
              const modeOption = MODE_OPTIONS.find(
                (m) => m.value === repo.mode
              )!;
              const isOpen = openRepoDropdown === repo.name;
              const isEnabled = repo.enabled !== false;
              // For "All Repos", exclude the "All PRs" mode since it would be too broad
              const availableModes = isAllRepos
                ? MODE_OPTIONS.filter((m) => m.value !== "all")
                : MODE_OPTIONS;

              return (
                <div key={repo.name} className="relative">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      if (!isOpen) {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setRepoDropdownPosition({
                          top: rect.bottom + 4,
                          left: rect.left,
                        });
                      }
                      setOpenRepoDropdown(isOpen ? null : repo.name);
                      setShowAddRepo(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        setRepoDropdownPosition({
                          top: rect.bottom + 4,
                          left: rect.left,
                        });
                        setOpenRepoDropdown(isOpen ? null : repo.name);
                        setShowAddRepo(false);
                      }
                    }}
                    className={cn(
                      "inline-flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-md text-xs transition-colors border cursor-pointer",
                      isOpen
                        ? "bg-muted border-border"
                        : isAllRepos
                          ? isEnabled
                            ? "bg-primary/10 border-primary/30 hover:bg-primary/20 hover:border-primary/50"
                            : "bg-muted/30 border-border/50 opacity-50"
                          : isEnabled
                            ? "bg-muted/50 border-transparent hover:bg-muted hover:border-border"
                            : "bg-muted/30 border-border/50 opacity-50"
                    )}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleRepo(repo.name, e.shiftKey);
                      }}
                      className={cn(
                        "p-0.5 rounded transition-colors",
                        isEnabled
                          ? "hover:bg-muted-foreground/20 text-muted-foreground hover:text-foreground"
                          : "hover:bg-muted-foreground/20 text-muted-foreground/50 hover:text-foreground"
                      )}
                      title={`${isEnabled ? "Disable filter" : "Enable filter"} (shift-click: toggle others)`}
                    >
                      {isEnabled ? (
                        <Eye className="w-3 h-3" />
                      ) : (
                        <EyeOff className="w-3 h-3" />
                      )}
                    </button>
                    <modeOption.icon
                      className={cn(
                        "w-3 h-3",
                        isAllRepos
                          ? isEnabled
                            ? "text-primary"
                            : "text-muted-foreground/50"
                          : "text-muted-foreground"
                      )}
                    />
                    <span
                      className={cn(
                        isAllRepos ? "font-medium" : "font-mono",
                        !isEnabled && "line-through"
                      )}
                    >
                      {isAllRepos ? modeOption.label : repo.name}
                    </span>
                    {repo.mode === "authored-by" && repo.authoredBy && (
                      <span
                        className={cn(
                          "text-muted-foreground",
                          !isEnabled && "line-through"
                        )}
                      >
                        @{repo.authoredBy}
                      </span>
                    )}
                    <ChevronDown className="w-3 h-3 text-muted-foreground" />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveRepo(repo.name);
                      }}
                      className="p-0.5 rounded hover:bg-destructive/20 hover:text-destructive transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>

                  {isOpen && (
                    <>
                      {/* Backdrop to close dropdown when clicking outside */}
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => {
                          setOpenRepoDropdown(null);
                          setShowAuthoredByInput(null);
                          setAuthoredByInput("");
                        }}
                      />
                      <div
                        className="fixed w-56 bg-card border border-border rounded-lg shadow-xl z-50 max-w-[calc(100vw-1rem)] sm:max-w-none"
                        style={{
                          top: repoDropdownPosition.top,
                          left: repoDropdownPosition.left,
                        }}
                      >
                        {showAuthoredByInput === repo.name ? (
                          <div className="p-3">
                            <div className="text-xs font-medium mb-2">
                              Enter GitHub username
                            </div>
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                if (authoredByInput.trim()) {
                                  handleRepoModeChange(
                                    repo.name,
                                    "authored-by",
                                    authoredByInput.trim()
                                  );
                                  setOpenRepoDropdown(null);
                                  setShowAuthoredByInput(null);
                                  setAuthoredByInput("");
                                }
                              }}
                            >
                              <div className="flex gap-2">
                                <div className="relative flex-1">
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">
                                    @
                                  </span>
                                  <input
                                    type="text"
                                    value={authoredByInput}
                                    onChange={(e) =>
                                      setAuthoredByInput(e.target.value)
                                    }
                                    placeholder="username"
                                    className="w-full h-7 pl-6 pr-2 rounded-md border border-border bg-muted/50 text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                                    autoFocus
                                  />
                                </div>
                                <button
                                  type="submit"
                                  disabled={!authoredByInput.trim()}
                                  className="px-2 py-1 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  Apply
                                </button>
                              </div>
                            </form>
                            <button
                              onClick={() => {
                                setShowAuthoredByInput(null);
                                setAuthoredByInput("");
                              }}
                              className="mt-2 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                            >
                              ← Back to modes
                            </button>
                          </div>
                        ) : (
                          availableModes.map((option) => (
                            <button
                              key={option.value}
                              onClick={() => {
                                if (option.value === "authored-by") {
                                  setShowAuthoredByInput(repo.name);
                                  setAuthoredByInput(repo.authoredBy || "");
                                } else {
                                  handleRepoModeChange(repo.name, option.value);
                                  setOpenRepoDropdown(null);
                                }
                              }}
                              className={cn(
                                "w-full flex items-start gap-2.5 px-3 py-2 hover:bg-muted/50 transition-colors text-left",
                                repo.mode === option.value && "bg-muted/50"
                              )}
                            >
                              <option.icon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="font-medium text-xs">
                                  {option.label}
                                  {option.value === "authored-by" &&
                                    repo.mode === "authored-by" &&
                                    repo.authoredBy && (
                                      <span className="text-muted-foreground font-normal ml-1">
                                        @{repo.authoredBy}
                                      </span>
                                    )}
                                </div>
                                <div className="text-[10px] text-muted-foreground">
                                  {option.description}
                                </div>
                              </div>
                              {repo.mode === option.value && (
                                <Check className="w-3.5 h-3.5 text-primary mt-0.5" />
                              )}
                            </button>
                          ))
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Save / Save-new + Add Repo — pushed to right. */}
          <div className="flex items-center gap-2 shrink-0 ml-auto">
            {/* Save / Save-new for the current filter group. Only visible when
                the working config differs from the group's saved state, or
                when the naming input is active. Naming swaps the buttons in
                place: Enter confirms, Escape cancels. */}
            {isNamingGroup ? (
              <div className="flex items-center gap-2 shrink-0">
                <input
                  type="text"
                  value={newGroupName}
                  autoFocus
                  placeholder="Group name"
                  onChange={(e) => {
                    setNewGroupName(e.target.value);
                    if (newGroupNameError) setNewGroupNameError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleSaveNewGroup(newGroupName);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelNaming();
                    }
                  }}
                  className={cn(
                    "h-7 px-2 rounded-md border bg-muted/50 text-xs focus:outline-none focus:ring-2 focus:ring-ring",
                    newGroupNameError
                      ? "border-destructive focus:ring-destructive/40"
                      : "border-border focus:border-transparent"
                  )}
                />
                {newGroupNameError && (
                  <span className="text-xs text-destructive">
                    {newGroupNameError}
                  </span>
                )}
                <button
                  onClick={() => handleSaveNewGroup(newGroupName)}
                  className="px-2 py-1 text-xs font-medium rounded hover:bg-muted/50 transition-colors"
                >
                  Confirm
                </button>
                <button
                  onClick={cancelNaming}
                  className="px-2 py-1 text-xs font-medium rounded hover:bg-muted/50 transition-colors text-muted-foreground"
                >
                  Cancel
                </button>
              </div>
            ) : (
              isDirty && (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={handleSaveGroup}
                    className="px-2 py-1 text-xs font-medium rounded bg-primary/10 hover:bg-primary/20 text-primary transition-colors"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setIsNamingGroup(true)}
                    className="px-2 py-1 text-xs font-medium rounded hover:bg-muted/50 transition-colors"
                  >
                    Save new
                  </button>
                </div>
              )
            )}

            {/* Add Repo Button */}
            <div className="relative shrink-0">
              <button
                ref={setAddRepoButtonRef}
                onClick={() => {
                  if (!showAddRepo && addRepoButtonRef) {
                    const rect = addRepoButtonRef.getBoundingClientRect();
                    setAddRepoDropdownPosition({
                      top: rect.bottom + 4,
                      right: window.innerWidth - rect.right,
                    });
                  }
                  setShowAddRepo(!showAddRepo);
                  setOpenRepoDropdown(null);
                }}
                className={cn(
                  "group relative flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200",
                  "bg-gradient-to-r from-emerald-500/10 via-green-500/10 to-teal-500/10",
                  "border border-emerald-500/20 hover:border-emerald-500/40",
                  "text-emerald-400 hover:text-emerald-300",
                  "hover:shadow-[0_0_20px_rgba(16,185,129,0.15)]",
                  "hover:from-emerald-500/15 hover:via-green-500/15 hover:to-teal-500/15",
                  showAddRepo &&
                    "border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.2)] from-emerald-500/20 via-green-500/20 to-teal-500/20"
                )}
              >
                <span
                  className={cn(
                    "flex items-center justify-center w-4 h-4 rounded-md transition-all duration-200",
                    "bg-emerald-500/20 group-hover:bg-emerald-500/30 group-hover:scale-110",
                    showAddRepo && "bg-emerald-500/30 rotate-45"
                  )}
                >
                  <Plus className="w-3 h-3" />
                </span>
                <span>Add Repo</span>
              </button>

              {/* Search Dropdown */}
              {showAddRepo && (
                <>
                  {/* Backdrop to close dropdown when clicking outside */}
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => {
                      setShowAddRepo(false);
                      setSearchQuery("");
                    }}
                  />
                  <div
                    className="fixed w-72 max-w-[calc(100vw-1rem)] bg-card border border-border rounded-lg shadow-xl z-50"
                    style={{
                      top: addRepoDropdownPosition.top,
                      right: addRepoDropdownPosition.right,
                    }}
                  >
                    <div className="p-2 border-b border-border">
                      <div className="relative">
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Search repositories..."
                          className="w-full h-7 pl-7 pr-3 rounded-md border border-border bg-muted/50 text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                          autoFocus
                        />
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                        {searching && (
                          <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 animate-spin text-muted-foreground" />
                        )}
                      </div>
                    </div>

                    <div className="add-repo-dropdown max-h-64 overflow-auto">
                      {/* All Repos option - always shown at top when not already added */}
                      {!config.repos.some(isAllReposFilter) && !searchQuery && (
                        <button
                          onMouseDown={() => {
                            handleAddRepo(ALL_REPOS_KEY);
                            setShowAddRepo(false);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-primary/10 transition-colors text-left border-b border-border bg-primary/5"
                        >
                          <div className="w-4 h-4 rounded bg-primary/20 flex items-center justify-center shrink-0">
                            <Users className="w-3 h-3 text-primary" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="font-medium text-xs">
                              All Repos
                            </span>
                            <span className="text-[10px] text-muted-foreground ml-1.5">
                              PRs across all repositories
                            </span>
                          </div>
                        </button>
                      )}
                      {searchResults.length > 0 ? (
                        searchResults.map((repo) => (
                          <button
                            key={repo.id}
                            onMouseDown={() => {
                              handleAddRepo(repo.full_name);
                              setShowAddRepo(false);
                              setSearchQuery("");
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors text-left border-b border-border/50 last:border-b-0"
                          >
                            {repo.owner && (
                              <img
                                src={repo.owner.avatar_url}
                                alt={repo.owner.login}
                                className="w-4 h-4 rounded shrink-0"
                              />
                            )}
                            <span className="font-medium text-xs truncate flex-1">
                              {repo.full_name}
                            </span>
                            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                              <Star className="w-3 h-3" />
                              {(repo.stargazers_count ?? 0).toLocaleString()}
                            </span>
                          </button>
                        ))
                      ) : searchQuery ? (
                        <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                          {searching ? "Searching..." : "No repositories found"}
                        </div>
                      ) : (
                        <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                          Type to search for repositories
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* PR List Panel */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Results Header */}
          <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border shrink-0">
            <div className="flex items-center gap-3 min-w-0 flex-1 overflow-x-auto hide-scrollbar">
              {/* State Toggle */}
              <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-muted/50 shrink-0">
                {STATE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => handleStateChange(option.value)}
                    className={cn(
                      "px-2 py-1 text-xs font-medium rounded transition-colors",
                      stateFilter === option.value
                        ? "bg-background shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              {/* UPDATED / STALLED Filter Toggles */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setShowUpdatedOnly((v) => !v)}
                    className={cn(
                      "shrink-0 px-2 py-1 text-xs font-medium rounded transition-colors",
                      showUpdatedOnly
                        ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                        : "text-muted-foreground hover:text-foreground border border-transparent"
                    )}
                  >
                    Updated
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start">
                  PRs with activity since your last review or visit
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setShowStalledOnly((v) => !v)}
                    className={cn(
                      "shrink-0 px-2 py-1 text-xs font-medium rounded transition-colors",
                      showStalledOnly
                        ? "bg-red-500/20 text-red-400 border border-red-500/30"
                        : "text-muted-foreground hover:text-foreground border border-transparent"
                    )}
                  >
                    Stalled
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="start">
                  No activity for at least {STALLED_DAYS} days
                </TooltipContent>
              </Tooltip>

              {/* Divider between the filter toggles and the results count. */}
              <div aria-hidden className="h-4 w-px bg-border shrink-0" />

              <span className="text-xs text-muted-foreground shrink-0">
                {prListPending ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Loading...
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <span>
                      <span className="font-medium text-foreground">
                        {totalCount.toLocaleString()}
                      </span>{" "}
                      pull requests
                    </span>
                    {loadingPrs && <Loader2 className="w-3 h-3 animate-spin" />}
                  </span>
                )}
              </span>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {dataUpdatedAt > 0 && !loadingPrs && (
                <RefreshCountdown lastFetchedAt={dataUpdatedAt} />
              )}
              <button
                onClick={refreshPRList}
                disabled={loadingPrs}
                className={cn(
                  "p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground",
                  loadingPrs && "opacity-50"
                )}
                title="Refresh"
              >
                <RefreshCw
                  className={cn("w-3.5 h-3.5", loadingPrs && "animate-spin")}
                />
              </button>
            </div>
          </div>

          {/* PR List */}
          <div className="flex-1 overflow-auto">
            {config.repos.length > 0 && prListPending ? (
              <PRListSkeleton count={8} />
            ) : filteredPrs.length === 0 && showStalledOnly ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <GitPullRequest className="w-12 h-12 text-muted-foreground/30 mb-4" />
                <p className="text-lg font-medium text-muted-foreground">
                  No stalled pull requests
                </p>
                <p className="text-sm text-muted-foreground/70 mt-1 max-w-md">
                  All open PRs have been active recently
                </p>
              </div>
            ) : prs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <GitPullRequest className="w-12 h-12 text-muted-foreground/30 mb-4" />
                <p className="text-lg font-medium text-muted-foreground">
                  No pull requests found
                </p>
                <p className="text-sm text-muted-foreground/70 mt-1 max-w-md">
                  {config.repos.length === 0
                    ? "Add a filter to get started"
                    : config.repos.some(isAllReposFilter)
                      ? "No PRs match your current filters"
                      : "Try adjusting your filter settings"}
                </p>
              </div>
            ) : filteredPrs.length === 0 && showUpdatedOnly ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <GitPullRequest className="w-12 h-12 text-muted-foreground/30 mb-4" />
                <p className="text-lg font-medium text-muted-foreground">
                  No updated pull requests
                </p>
                <p className="text-sm text-muted-foreground/70 mt-1 max-w-md">
                  All your PRs are up to date
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {filteredPrs.map((pr) => (
                  <PRListItem key={pr.id} pr={pr} onSelect={handleOpenPR} />
                ))}
              </div>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="border-t border-border px-4 py-3 shrink-0">
              <Pagination>
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className={cn(
                        "cursor-pointer",
                        page === 1 && "pointer-events-none opacity-50"
                      )}
                    />
                  </PaginationItem>

                  {totalPages <= 7 ? (
                    Array.from({ length: totalPages }, (_, i) => (
                      <PaginationItem key={i + 1}>
                        <PaginationLink
                          onClick={() => setPage(i + 1)}
                          isActive={page === i + 1}
                          className="cursor-pointer"
                        >
                          {i + 1}
                        </PaginationLink>
                      </PaginationItem>
                    ))
                  ) : (
                    <>
                      {[1, 2, 3].map((n) => (
                        <PaginationItem key={n}>
                          <PaginationLink
                            onClick={() => setPage(n)}
                            isActive={page === n}
                            className="cursor-pointer"
                          >
                            {n}
                          </PaginationLink>
                        </PaginationItem>
                      ))}
                      {page > 4 && (
                        <PaginationItem>
                          <span className="px-2">...</span>
                        </PaginationItem>
                      )}
                      {page > 3 && page < totalPages - 2 && (
                        <PaginationItem>
                          <PaginationLink isActive className="cursor-pointer">
                            {page}
                          </PaginationLink>
                        </PaginationItem>
                      )}
                      {page < totalPages - 3 && (
                        <PaginationItem>
                          <span className="px-2">...</span>
                        </PaginationItem>
                      )}
                      {[totalPages - 2, totalPages - 1, totalPages]
                        .filter((n) => n > 3)
                        .map((n) => (
                          <PaginationItem key={n}>
                            <PaginationLink
                              onClick={() => setPage(n)}
                              isActive={page === n}
                              className="cursor-pointer"
                            >
                              {n}
                            </PaginationLink>
                          </PaginationItem>
                        ))}
                    </>
                  )}

                  <PaginationItem>
                    <PaginationNext
                      onClick={() =>
                        setPage((p) => Math.min(totalPages, p + 1))
                      }
                      className={cn(
                        "cursor-pointer",
                        page === totalPages && "pointer-events-none opacity-50"
                      )}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// PR List Item
// ============================================================================

interface PRListItemProps {
  pr: PRSearchResult;
  onSelect: (
    owner: string,
    repo: string,
    number: number,
    title: string
  ) => void;
}

function PRListItem({ pr, onSelect }: PRListItemProps) {
  const repoInfo = extractRepoFromUrl(pr.repository_url);
  const isMerged = pr.pull_request?.merged_at != null;
  const isClosed = pr.state === "closed" && !isMerged;

  // Compute whether the PR is stalled (no activity in 14+ days)
  const isStalled = useMemo(() => {
    if (!pr.updated_at || pr.state !== "open") return false;
    const threshold = Date.now() - 14 * 86400000;
    return new Date(pr.updated_at).getTime() < threshold;
  }, [pr.updated_at, pr.state]);

  // Compute whether the PR has new content since the user last saw it
  const hasNewContent = useMemo(() => {
    if (!repoInfo) return false;
    const prId = `${repoInfo.owner}/${repoInfo.repo}#${pr.number}`;
    const viewerLastViewedAt = getLastViewed(prId);
    const baselines: string[] = [];
    if (pr.viewerLastReviewAt) baselines.push(pr.viewerLastReviewAt);
    if (viewerLastViewedAt) baselines.push(viewerLastViewedAt);
    if (pr.isReadByViewer && pr.updated_at) baselines.push(pr.updated_at);
    if (baselines.length === 0) return true;
    const baseline = baselines.reduce((a, b) => (a > b ? a : b));
    return pr.updated_at ? pr.updated_at > baseline : false;
  }, [repoInfo, pr.updated_at, pr.viewerLastReviewAt, pr.isReadByViewer]);

  const handleClick = () => {
    if (repoInfo) {
      onSelect(repoInfo.owner, repoInfo.repo, pr.number, pr.title);
    }
  };

  // CI status indicator with details
  const CIStatusBadge = () => {
    if (!pr.ciStatus || pr.ciStatus === "none") return null;

    const summary =
      pr.ciSummary ||
      (pr.ciStatus === "success"
        ? "Passed"
        : pr.ciStatus === "failure"
          ? "Failed"
          : pr.ciStatus === "action_required"
            ? "Approval needed"
            : "Running");

    // Group checks by state for tooltip display
    const checks = pr.ciChecks || [];
    const successChecks = checks.filter((c) => c.state === "success");
    const failureChecks = checks.filter((c) => c.state === "failure");
    const skippedChecks = checks.filter((c) => c.state === "skipped");
    const pendingChecks = checks.filter(
      (c) =>
        c.state !== "success" && c.state !== "failure" && c.state !== "skipped"
    );

    const TooltipChecks = () => (
      <div className="min-w-[200px] max-w-[300px]">
        <div className="font-medium text-xs mb-2 pb-1.5 border-b border-border flex items-center gap-2">
          {pr.ciStatus === "success" && (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
              <span>All checks passed</span>
            </>
          )}
          {pr.ciStatus === "failure" && (
            <>
              <XCircle className="w-3.5 h-3.5 text-red-500" />
              <span>Some checks failed</span>
            </>
          )}
          {pr.ciStatus === "pending" && (
            <>
              <Clock className="w-3.5 h-3.5 text-yellow-500" />
              <span>Checks in progress</span>
            </>
          )}
          {pr.ciStatus === "action_required" && (
            <>
              <AlertCircle className="w-3.5 h-3.5 text-yellow-500" />
              <span>Action required</span>
            </>
          )}
        </div>
        {checks.length > 0 ? (
          <div className="space-y-2">
            {/* Failed checks first */}
            {failureChecks.length > 0 && (
              <div className="space-y-1">
                {failureChecks.map((c) => (
                  <div
                    key={c.name}
                    className="flex items-center gap-2 text-[11px]"
                  >
                    <XCircle className="w-3 h-3 text-red-500 shrink-0" />
                    <span className="truncate text-red-400">{c.name}</span>
                  </div>
                ))}
              </div>
            )}
            {/* Pending checks */}
            {pendingChecks.length > 0 && (
              <div className="space-y-1">
                {pendingChecks.map((c) => (
                  <div
                    key={c.name}
                    className="flex items-center gap-2 text-[11px]"
                  >
                    <Circle className="w-3 h-3 text-yellow-500 shrink-0" />
                    <span className="truncate text-muted-foreground">
                      {c.name}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {/* Successful checks (collapsed if many) */}
            {successChecks.length > 0 && (
              <div className="space-y-1">
                {successChecks.length <= 5 ? (
                  successChecks.map((c) => (
                    <div
                      key={c.name}
                      className="flex items-center gap-2 text-[11px]"
                    >
                      <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
                      <span className="truncate text-muted-foreground">
                        {c.name}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
                    <span>{successChecks.length} checks passed</span>
                  </div>
                )}
              </div>
            )}
            {/* Skipped checks */}
            {skippedChecks.length > 0 && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <div className="w-3 h-3 rounded-full border border-muted-foreground shrink-0 flex items-center justify-center">
                  <div className="w-1.5 h-px bg-muted-foreground" />
                </div>
                <span>{skippedChecks.length} checks skipped</span>
              </div>
            )}
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground">
            {pr.ciStatus === "action_required"
              ? "Workflow approval required from a maintainer"
              : "No detailed check information available"}
          </div>
        )}
      </div>
    );

    const badgeContent = (className: string, icon: React.ReactNode) => (
      <span
        className={cn(
          "shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border cursor-default",
          className
        )}
      >
        {icon}
        <span className="hidden sm:inline max-w-[100px] truncate">
          {summary}
        </span>
      </span>
    );

    switch (pr.ciStatus) {
      case "success":
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              {badgeContent(
                "bg-green-500/15 text-green-500 border-green-500/30",
                <CheckCircle2 className="w-3 h-3" />
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start">
              <TooltipChecks />
            </TooltipContent>
          </Tooltip>
        );
      case "failure":
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              {badgeContent(
                "bg-red-500/15 text-red-500 border-red-500/30",
                <XCircle className="w-3 h-3" />
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start">
              <TooltipChecks />
            </TooltipContent>
          </Tooltip>
        );
      case "pending":
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              {badgeContent(
                "bg-yellow-500/15 text-yellow-500 border-yellow-500/30",
                <Circle className="w-3 h-3 animate-pulse" />
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start">
              <TooltipChecks />
            </TooltipContent>
          </Tooltip>
        );
      case "action_required":
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              {badgeContent(
                "bg-yellow-500/15 text-yellow-500 border-yellow-500/30",
                <AlertCircle className="w-3 h-3" />
              )}
            </TooltipTrigger>
            <TooltipContent side="bottom" align="start">
              <TooltipChecks />
            </TooltipContent>
          </Tooltip>
        );
      default:
        return null;
    }
  };

  // Review status indicator with reviewer details
  const ReviewStatusBadge = () => {
    // Don't show review status for merged/closed PRs
    if (isMerged || isClosed) return null;

    const reviews = pr.latestReviews || [];
    const approvals = reviews.filter((r) => r.state === "APPROVED");
    const changesRequested = reviews.filter(
      (r) => r.state === "CHANGES_REQUESTED"
    );

    // No reviews yet
    if (reviews.length === 0 && !pr.reviewDecision) return null;

    const TooltipReviews = () => (
      <div className="min-w-[150px] max-w-[250px]">
        <div className="font-medium text-xs mb-2 pb-1.5 border-b border-border flex items-center gap-2">
          {pr.reviewDecision === "APPROVED" && (
            <>
              <Check className="w-3.5 h-3.5 text-green-500" />
              <span>Approved</span>
            </>
          )}
          {pr.reviewDecision === "CHANGES_REQUESTED" && (
            <>
              <XCircle className="w-3.5 h-3.5 text-red-500" />
              <span>Changes requested</span>
            </>
          )}
          {pr.reviewDecision === "REVIEW_REQUIRED" && (
            <>
              <Clock className="w-3.5 h-3.5 text-yellow-500" />
              <span>Review required</span>
            </>
          )}
          {!pr.reviewDecision && reviews.length > 0 && (
            <>
              <MessageSquare className="w-3.5 h-3.5 text-muted-foreground" />
              <span>Reviewed</span>
            </>
          )}
        </div>
        {reviews.length > 0 ? (
          <div className="space-y-1.5">
            {changesRequested.map((r) => (
              <div
                key={r.login}
                className="flex items-center gap-2 text-[11px]"
              >
                <img
                  src={r.avatarUrl}
                  alt={r.login}
                  className="w-4 h-4 rounded-full"
                />
                <span className="truncate text-red-400">{r.login}</span>
                <XCircle className="w-3 h-3 text-red-500 shrink-0 ml-auto" />
              </div>
            ))}
            {approvals.map((r) => (
              <div
                key={r.login}
                className="flex items-center gap-2 text-[11px]"
              >
                <img
                  src={r.avatarUrl}
                  alt={r.login}
                  className="w-4 h-4 rounded-full"
                />
                <span className="truncate text-green-400">{r.login}</span>
                <Check className="w-3 h-3 text-green-500 shrink-0 ml-auto" />
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground">
            Waiting for review
          </div>
        )}
      </div>
    );

    // Display based on review state
    if (pr.reviewDecision === "APPROVED" || approvals.length > 0) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border cursor-default bg-green-500/15 text-green-500 border-green-500/30">
              <Check className="w-3 h-3" />
              <span className="hidden sm:inline">
                {approvals.length > 0 ? `${approvals.length}` : "Approved"}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start">
            <TooltipReviews />
          </TooltipContent>
        </Tooltip>
      );
    }

    if (
      pr.reviewDecision === "CHANGES_REQUESTED" ||
      changesRequested.length > 0
    ) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border cursor-default bg-red-500/15 text-red-500 border-red-500/30">
              <XCircle className="w-3 h-3" />
              <span className="hidden sm:inline">Changes</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start">
            <TooltipReviews />
          </TooltipContent>
        </Tooltip>
      );
    }

    return null;
  };

  return (
    <button
      onClick={handleClick}
      className="w-full flex items-start gap-2 sm:gap-3 px-2 sm:px-4 py-3 hover:bg-muted/50 transition-colors text-left"
    >
      {/* PR Icon */}
      {isMerged ? (
        <GitMerge className="w-4 h-4 mt-0.5 shrink-0 text-purple-500" />
      ) : isClosed ? (
        <GitPullRequest className="w-4 h-4 mt-0.5 shrink-0 text-red-500" />
      ) : pr.inMergeQueue ? (
        <GitPullRequest
          className="w-4 h-4 mt-0.5 shrink-0"
          style={{ color: "#9a6700" }}
        />
      ) : (
        <GitPullRequest
          className={cn(
            "w-4 h-4 mt-0.5 shrink-0",
            pr.draft ? "text-muted-foreground" : "text-green-500"
          )}
        />
      )}

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium hover:text-blue-400 break-words">
            {pr.title}
          </span>
          <CIStatusBadge />
          <ReviewStatusBadge />
          {pr.hasNewChanges && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-blue-500/20 text-blue-400 border border-blue-500/30 shrink-0 cursor-default">
                  NEW CHANGES
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start">
                New commits have been pushed since your last review
              </TooltipContent>
            </Tooltip>
          )}
          {hasNewContent && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 shrink-0 cursor-default">
                  NEW ACTIVITY
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start">
                This PR has activity since you last viewed it
              </TooltipContent>
            </Tooltip>
          )}
          {/* Labels - hide on mobile to save space */}
          {pr.labels.slice(0, 3).map((label) => (
            <span
              key={label.name}
              className="px-2 py-0.5 text-[11px] font-medium rounded-full hidden sm:inline-block"
              style={{
                backgroundColor: `#${label.color}20`,
                color: `#${label.color}`,
                border: `1px solid #${label.color}40`,
              }}
            >
              {label.name}
            </span>
          ))}
        </div>
        <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5 flex-wrap">
          {repoInfo && (
            <>
              <span className="font-mono truncate max-w-[120px] sm:max-w-none">
                {repoInfo.owner}/{repoInfo.repo}
              </span>
              <span>•</span>
            </>
          )}
          <span>#{pr.number}</span>
          <span className="hidden xs:inline">•</span>
          <span className={cn("hidden xs:inline", isStalled && "text-red-500")}>
            {getTimeAgo(new Date(pr.updated_at))}
          </span>
          {pr.user && (
            <>
              <span className="hidden sm:inline">•</span>
              <UserHoverCard login={pr.user.login}>
                <span className="hover:text-blue-400 hover:underline cursor-pointer hidden sm:inline">
                  {pr.user.login}
                </span>
              </UserHoverCard>
            </>
          )}
          {pr.changedFiles !== undefined && (
            <>
              <span className="hidden sm:inline">•</span>
              <span className="hidden sm:flex items-center gap-1">
                <FileCode className="w-3 h-3" />
                {pr.changedFiles}
              </span>
            </>
          )}
          {(pr.additions !== undefined || pr.deletions !== undefined) && (
            <>
              <span className="hidden sm:inline">•</span>
              <span className="hidden sm:inline">
                <span className="text-green-500">+{pr.additions || 0}</span>{" "}
                <span className="text-red-500">−{pr.deletions || 0}</span>
              </span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

// ============================================================================
// Refresh Countdown
// ============================================================================

const REFRESH_INTERVAL_SECONDS = 60;

function RefreshCountdown({ lastFetchedAt }: { lastFetchedAt: number }) {
  const [secondsRemaining, setSecondsRemaining] = useState(() => {
    const elapsed = Math.floor((Date.now() - lastFetchedAt) / 1000);
    return Math.max(0, REFRESH_INTERVAL_SECONDS - elapsed);
  });

  useEffect(() => {
    // Recalculate on mount or when lastFetchedAt changes
    const elapsed = Math.floor((Date.now() - lastFetchedAt) / 1000);
    setSecondsRemaining(Math.max(0, REFRESH_INTERVAL_SECONDS - elapsed));

    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - lastFetchedAt) / 1000);
      const remaining = Math.max(0, REFRESH_INTERVAL_SECONDS - elapsed);
      setSecondsRemaining(remaining);
    }, 1000);

    return () => clearInterval(interval);
  }, [lastFetchedAt]);

  return (
    <span className="text-[10px] text-muted-foreground tabular-nums">
      Refreshing in {secondsRemaining}s
    </span>
  );
}

// ============================================================================
// Skeleton Components
// ============================================================================

function HomeLoadingSkeleton() {
  return (
    <div className="h-full bg-background flex flex-col overflow-hidden">
      {/* Filter Bar Skeleton */}
      <div className="border-b border-border px-4 py-2 shrink-0 flex items-center gap-3 bg-card/30">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-6 w-48" />
        <div className="flex-1" />
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-7 w-[200px]" />
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Results Header Skeleton */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-20" />
          </div>

          {/* PR List Skeleton */}
          <PRListSkeleton count={8} />
        </div>
      </div>
    </div>
  );
}

function PRListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="divide-y divide-border">
      {Array.from({ length: count }).map((_, i) => (
        <PRListItemSkeleton key={i} />
      ))}
    </div>
  );
}

function PRListItemSkeleton() {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      {/* PR Icon */}
      <Skeleton className="w-4 h-4 mt-0.5 rounded-full shrink-0" />

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-[60%]" />
          <Skeleton className="h-4 w-12 rounded-full" />
        </div>
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-8" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
    </div>
  );
}
