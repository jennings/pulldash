import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useNavigate } from "react-router-dom";

import {
  Loader2,
  MessageSquare,
  X,
  ChevronsUpDown,
  Check,
  XCircle,
  MessageCircle,
  Eye,
  EyeOff,
  FileCode,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Search,
  ExternalLink,
  BookOpen,
  GitPullRequest,
  GitMerge,
  GitCommit,
} from "lucide-react";
import { subscribePRRefresh } from "../lib/pr-refresh-bus";
import { Skeleton } from "../ui/skeleton";
import { PROverview } from "./pr-overview";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../cn";
import { PRHeader } from "./pr-header";
import { FileTree } from "./file-tree";
import { FileHeader } from "./file-header";
import type {
  PullRequest,
  PullRequestFile,
  Review,
  ReviewComment,
} from "@/api/types";
import {
  useGitHub,
  useGitHubStore,
  useGitHubReady,
  useGitHubSelector,
  usePRChecks,
} from "../contexts/github";
import { useCanWrite, useAuth } from "../contexts/auth";
import {
  PRReviewProvider,
  usePRReviewSelector,
  usePRReviewStore,
  useKeyboardNavigation,
  useHashNavigation,
  useRouteNavigation,
  useDiffLoader,
  usePendingReviewLoader,
  useCurrentUserLoader,
  useCommentActions,
  useReviewActions,
  useFileCopyActions,
  useCurrentFile,
  useCurrentDiff,
  useIsCurrentFileLoading,
  useCommentCountsByFile,
  usePendingCommentCountsByFile,
  type LocalPendingComment,
} from "../contexts/pr-review";
import { getTimeAgo } from "../lib/dates";
import { useDraft } from "../hooks/use-draft";
import {
  stripCommitMetadataPrefix,
  isMetadataComment,
  parseCommitMetadataMarker,
} from "../../shared/commit-metadata";
import { stripReviewGroupMarker } from "../../shared/review-group";
import type { LoadedDiff } from "../lib/file-diff";
import { isForeignUiEvent } from "../lib/foreign-ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { Keycap, KeycapGroup } from "../ui/keycap";
import { MarkdownEditor } from "../ui/markdown";
import { CommandPalette } from "./command-palette";
import { useCommandPalette } from "../contexts/command-palette";
import {
  ConversationsSidebar,
  useConversationsSidebarCount,
} from "./conversations-sidebar";
import { useTabContext, type TabStatus } from "../contexts/tabs";
import { DiffViewer } from "./diff-viewer/diff-viewer";

// ============================================================================
// Hook to sync PR check status with tab
// ============================================================================

function useSyncTabStatus(
  tabId: string | undefined,
  owner: string,
  repo: string,
  number: number,
  prData: {
    merged: boolean;
    draft?: boolean;
    state: string;
    mergeable: boolean | null;
  } | null,
  inMergeQueue: boolean
) {
  const { status: checkStatus } = usePRChecks(owner, repo, number);

  // Get tab context for status updates
  let updateTabStatus: ((tabId: string, status: TabStatus) => void) | undefined;
  try {
    const tabContext = useTabContext();
    updateTabStatus = tabContext.updateTabStatus;
  } catch {
    // Not in tab context, ignore
  }

  // Sync to tab whenever status changes
  useEffect(() => {
    if (!tabId || !updateTabStatus || !prData) return;

    const state: TabStatus["state"] = prData.merged
      ? "merged"
      : prData.draft
        ? "draft"
        : prData.state === "open"
          ? "open"
          : "closed";

    updateTabStatus(tabId, {
      checks: checkStatus?.checks || "pending",
      state,
      mergeable: prData.mergeable,
      inMergeQueue,
    });
  }, [tabId, updateTabStatus, prData, checkStatus, inMergeQueue]);
}

// Syncs tab status from the PR review store, so optimistic updates
// (draft <-> ready, merge/close) reflect on the tab dot immediately.
function TabStatusSync({
  tabId,
  owner,
  repo,
  number,
}: {
  tabId?: string;
  owner: string;
  repo: string;
  number: number;
}) {
  const pr = usePRReviewSelector((s) => s.pr);
  const prInMergeQueue = usePRReviewSelector((s) => s.prInMergeQueue);
  useSyncTabStatus(tabId, owner, repo, number, pr, prInMergeQueue);
  return null;
}

// ============================================================================
// Page Component (Data Fetching) - Used for direct URL access
// ============================================================================

export function PRReviewPage() {
  const { owner, repo, number } = useParams<{
    owner: string;
    repo: string;
    number: string;
  }>();

  if (!owner || !repo || !number) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-destructive">Invalid PR URL</p>
      </div>
    );
  }

  return (
    <PRReviewContent owner={owner} repo={repo} number={parseInt(number, 10)} />
  );
}

// ============================================================================
// Content Component (Used by tabs and direct URL)
// ============================================================================

interface PRReviewContentProps {
  owner: string;
  repo: string;
  number: number;
  tabId?: string;
  cachedPr?: {
    title: string;
    user: { login: string; avatar_url: string };
  } | null;
}

interface PRFetchResult {
  pr: PullRequest;
  files: PullRequestFile[];
  comments: ReviewComment[];
  viewerPermission: string | null;
}

export function PRReviewContent({
  owner,
  repo,
  number,
  tabId,
  cachedPr,
}: PRReviewContentProps) {
  const { ready: githubReady, error: githubError } = useGitHubReady();
  const github = useGitHubStore();
  const [fetchedData, setFetchedData] = useState<PRFetchResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Get tab context for caching PR metadata on tab switch
  let updateTabMeta:
    | ((
        tabId: string,
        meta: {
          prTitle?: string;
          prAuthor?: { login: string; avatar_url: string };
        }
      ) => void)
    | undefined;
  try {
    const tabContext = useTabContext();
    updateTabMeta = tabContext.updateTabMeta;
  } catch {
    // Not in tab context, ignore
  }
  const fetchData = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) {
        setLoading(true);
        setError(null);
      }

      try {
        // Warm independent overview queries while the PR header is loading.
        github.getPRReviews(owner, repo, number).catch(() => {});
        github.getPRConversation(owner, repo, number).catch(() => {});
        github.getPRTimeline(owner, repo, number).catch(() => {});
        const prPromise = github.getPR(owner, repo, number);
        const detailsPromise = Promise.all([
          github.getPRFiles(owner, repo, number),
          github.getPRComments(owner, repo, number),
          github.getReviewThreads(owner, repo, number).catch(() => ({
            threads: [],
            viewerPermission: null,
            viewerCanMergeAsAdmin: false,
            isInMergeQueue: false,
          })),
        ]);
        // Attach rejection handling immediately while waiting for metadata.
        const dataPromise = Promise.all([prPromise, detailsPromise]);
        dataPromise.catch(() => {});
        if (!opts?.silent) {
          const pr = await prPromise;
          setFetchedData({
            pr,
            files: [],
            comments: [],
            viewerPermission: null,
          });
          setLoading(false);
        }
        const [pr, [files, comments, reviewThreadsResult]] = await dataPromise;

        // Cache PR metadata in tab for instant header on next switch
        if (updateTabMeta && tabId && pr.user) {
          updateTabMeta(tabId, {
            prTitle: pr.title,
            prAuthor: {
              login: pr.user.login,
              avatar_url: pr.user.avatar_url,
            },
          });
        }

        setFetchedData({
          pr,
          files,
          comments: comments as ReviewComment[],
          viewerPermission: reviewThreadsResult.viewerPermission,
        });
      } catch (e) {
        // Silent refreshes keep the current data on failure
        if (!opts?.silent) {
          setError(e instanceof Error ? e.message : "Unknown error");
        }
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [github, owner, repo, number, updateTabMeta, tabId]
  );

  useEffect(() => {
    if (!githubReady) return;
    fetchData();
  }, [githubReady, fetchData]);

  // In-place refresh when the poll detects new activity on this PR
  useEffect(() => {
    return subscribePRRefresh(owner, repo, number, () =>
      fetchData({ silent: true })
    );
  }, [owner, repo, number, fetchData]);

  // Show loading while GitHub client initializes
  if (!githubReady) {
    if (githubError) {
      return (
        <div className="flex items-center justify-center h-full">
          <div className="flex flex-col items-center gap-4">
            <p className="text-destructive font-medium">
              Failed to connect to GitHub
            </p>
            <p className="text-sm text-muted-foreground">{githubError}</p>
          </div>
        </div>
      );
    }
    return <PRReviewSkeleton />;
  }

  if (loading) {
    return (
      <div className="h-full flex flex-col">
        {cachedPr && (
          <header className="border-b border-border px-2 sm:px-4 py-2 flex items-center gap-2 sm:gap-3 shrink-0 bg-card/30">
            <span
              className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full text-white shrink-0 bg-green-600"
              )}
            >
              <GitPullRequest className="w-3.5 h-3.5" />
              <span className="hidden xs:inline">Open</span>
            </span>
            <h1 className="text-sm font-medium truncate flex-1 min-w-0">
              <span className="truncate">
                <span>{cachedPr.title}</span>
              </span>
            </h1>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
              <img
                src={cachedPr.user.avatar_url}
                alt={cachedPr.user.login}
                className="w-5 h-5 rounded-full"
              />
              <span className="hidden lg:inline">{cachedPr.user.login}</span>
            </div>
          </header>
        )}
        <PRReviewSkeleton />
      </div>
    );
  }

  if (error || !fetchedData) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4 max-w-md text-center">
          <p className="text-destructive font-medium">Failed to load PR</p>
          <p className="text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <PRReviewProvider
      github={github}
      pr={fetchedData.pr}
      files={fetchedData.files}
      comments={fetchedData.comments}
      owner={owner}
      repo={repo}
      viewerPermission={fetchedData.viewerPermission}
    >
      <TabStatusSync tabId={tabId} owner={owner} repo={repo} number={number} />
      <PRReviewLayout />
    </PRReviewProvider>
  );
}

// ============================================================================
// Main Review Component (Layout)
// ============================================================================

function PRReviewLayout() {
  const store = usePRReviewStore();
  const { open: commandPaletteOpen, setOpen: setCommandPaletteOpen } =
    useCommandPalette();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Expose for button click
  const openCommandPalette = useCallback(
    () => setCommandPaletteOpen(true),
    [setCommandPaletteOpen]
  );

  // Close mobile sidebar when a file is selected
  const handleMobileFileSelect = useCallback(() => {
    setMobileSidebarOpen(false);
  }, []);

  // Initialize hooks that load data
  useKeyboardNavigation();
  useHashNavigation();
  useRouteNavigation();
  useDiffLoader();
  usePendingReviewLoader();
  useCurrentUserLoader();

  // Listen for delete comment events from keyboard navigation
  const { deleteComment, removePendingComment } = useCommentActions();
  useEffect(() => {
    const handler = (e: CustomEvent<{ commentId: number }>) => {
      deleteComment(e.detail.commentId);
    };
    window.addEventListener(
      "pr-review:delete-comment",
      handler as EventListener
    );
    return () =>
      window.removeEventListener(
        "pr-review:delete-comment",
        handler as EventListener
      );
  }, [deleteComment]);

  // Listen for delete pending comment events from keyboard navigation
  useEffect(() => {
    const handler = (e: CustomEvent<{ commentId: string }>) => {
      removePendingComment(e.detail.commentId);
    };
    window.addEventListener(
      "pr-review:delete-pending-comment",
      handler as EventListener
    );
    return () =>
      window.removeEventListener(
        "pr-review:delete-pending-comment",
        handler as EventListener
      );
  }, [removePendingComment]);

  // Clear comment/line focus when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      // A click in an extension's injected UI (Grammarly renders its suggestion
      // popup in a shadow root beside the app) is not a navigation intent, so
      // it must not drop the reader's comment or line focus. Retargeting hides
      // that ancestry from `closest`, so the allowlist below cannot match it.
      if (isForeignUiEvent(e)) return;

      const target = e.target as HTMLElement;

      // Check if click is inside interactive elements that should NOT clear focus
      const isInteractive =
        target.closest("[data-comment-thread]") ||
        target.closest("[data-inline-comment-form]") ||
        // Pierre renders lines in a shadow root, so a click on one is
        // retargeted to its <diffs-container> host.
        target.closest("diffs-container") ||
        target.closest("button") ||
        target.closest("a") ||
        target.closest("textarea") ||
        target.closest("input") ||
        target.closest("[cmdk-root]");

      const state = store.getSnapshot();

      // Clear comment focus if clicking outside comments
      if (!isInteractive && state.focusedCommentId) {
        store.setFocusedCommentId(null);
      }

      // Clear line focus if clicking anywhere except diff lines and interactive elements
      if (!isInteractive && (state.focusedLine || state.selectionAnchor)) {
        store.clearLineSelection();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [store]);

  const pr = usePRReviewSelector((s) => s.pr);
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const prInMergeQueue = usePRReviewSelector((s) => s.prInMergeQueue);

  const canWrite = useCanWrite();

  return (
    <div className="flex flex-col h-full">
      <PRHeader
        pr={pr}
        owner={owner}
        repo={repo}
        inMergeQueue={prInMergeQueue}
        onToggleSidebar={() => setMobileSidebarOpen(!mobileSidebarOpen)}
        rightContent={canWrite ? <SubmitReviewDropdown /> : undefined}
      />

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Mobile sidebar overlay */}
        {mobileSidebarOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-40 lg:hidden"
            onClick={() => setMobileSidebarOpen(false)}
          />
        )}
        <FilePanel
          onOpenSearch={openCommandPalette}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={() => setMobileSidebarOpen(false)}
          onFileSelect={handleMobileFileSelect}
        />
        <DiffPanel />
      </div>

      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
      />
    </div>
  );
}

// ============================================================================
// File Panel (Sidebar)
// ============================================================================

interface FilePanelProps {
  onOpenSearch: () => void;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  onFileSelect?: () => void;
}

const FilePanel = memo(function FilePanel({
  onOpenSearch,
  mobileOpen,
  onMobileClose,
  onFileSelect,
}: FilePanelProps) {
  const store = usePRReviewStore();
  const files = usePRReviewSelector((s) => s.files);
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const selectedFiles = usePRReviewSelector((s) => s.selectedFiles);
  const viewedFilenames = usePRReviewSelector((s) => s.viewedFilenames);
  const hideViewed = usePRReviewSelector((s) => s.hideViewed);
  const showOverview = usePRReviewSelector((s) => s.showOverview);
  const interdiffEnabled = usePRReviewSelector((s) => s.interdiffEnabled);
  const interdiffLoadedDiffs = usePRReviewSelector(
    (s) => s.interdiffLoadedDiffs
  );
  const versionCompareNoChangeFiles = usePRReviewSelector(
    (s) => s.versionCompareNoChangeFiles
  );
  const selectedCommitSha = usePRReviewSelector((s) => s.selectedCommitSha);

  const displayFiles = useMemo(() => {
    if (!selectedCommitSha) return files;
    const commitFile: PullRequestFile = {
      filename: ":commit",
      sha: null,
      status: "modified",
      additions: 0,
      deletions: 0,
      changes: 0,
    } as PullRequestFile;
    return [commitFile, ...files];
  }, [files, selectedCommitSha]);

  const noChangeFiles = useMemo(() => {
    const result = new Set<string>();

    if (interdiffEnabled) {
      for (const file of files) {
        if (
          file.patch &&
          file.status !== "removed" &&
          interdiffLoadedDiffs[file.filename]?.fileDiff.hunks.length === 0
        )
          result.add(file.filename);
      }
    }

    for (const filename of versionCompareNoChangeFiles) {
      result.add(filename);
    }

    return result.size > 0 ? result : undefined;
  }, [
    interdiffEnabled,
    interdiffLoadedDiffs,
    files,
    versionCompareNoChangeFiles,
  ]);

  const commentCounts = useCommentCountsByFile();
  const pendingCommentCounts = usePendingCommentCountsByFile();
  const { copyDiff, copyFile, copyMainVersion } = useFileCopyActions();

  // Wrap file selection to close mobile sidebar
  const handleSelectFile = useCallback(
    (filename: string) => {
      store.selectFile(filename);
      onFileSelect?.();
    },
    [store, onFileSelect]
  );

  const handleSelectOverview = useCallback(() => {
    store.selectOverview();
    onFileSelect?.();
  }, [store, onFileSelect]);

  return (
    <aside
      className={cn(
        "w-64 border-r border-border flex flex-col overflow-hidden shrink-0 bg-background",
        // Mobile: absolute positioned drawer
        "fixed inset-y-0 left-0 z-50 transition-transform duration-200 ease-in-out lg:relative lg:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      )}
    >
      {/* Mobile close button */}
      <div className="flex items-center justify-between px-2 py-2 border-b border-border lg:hidden">
        <span className="text-sm font-medium">Files</span>
        <button
          onClick={onMobileClose}
          className="p-1 rounded hover:bg-muted transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Overview button - now above search */}
      <button
        onClick={handleSelectOverview}
        className={cn(
          "mx-2 mt-2 flex items-center gap-2 px-2 py-1.5 text-sm rounded-md transition-colors",
          showOverview
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        )}
      >
        <BookOpen className="w-4 h-4" />
        <span className="font-medium flex-1 text-left">Overview</span>
        <kbd className="px-1.5 py-0.5 bg-muted/60 rounded text-[10px] font-mono text-muted-foreground hidden sm:inline-block">
          o
        </kbd>
      </button>

      {/* Version / commit selectors (hidden when no push versions) */}
      <VersionBar />

      {/* Search button with hide-viewed toggle */}
      <div className="mx-2 my-2 flex items-center gap-1.5">
        <button
          onClick={onOpenSearch}
          className="flex-1 flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground bg-muted/50 hover:bg-muted rounded-md border border-border transition-colors"
        >
          <Search className="w-3.5 h-3.5" />
          <span className="flex-1 text-left">Search...</span>
          <KeycapGroup keys={["cmd", "k"]} size="xs" />
        </button>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={store.toggleHideViewed}
              className={cn(
                "p-1.5 rounded-md border border-border transition-colors",
                hideViewed
                  ? "bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 border-blue-500/30"
                  : "text-muted-foreground bg-muted/50 hover:bg-muted"
              )}
            >
              {hideViewed ? (
                <EyeOff className="w-3.5 h-3.5" />
              ) : (
                <Eye className="w-3.5 h-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {hideViewed ? "Show viewed files" : "Hide viewed files"}
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="border-t border-border/50" />

      <FileTree
        files={displayFiles}
        selectedFile={selectedFile}
        selectedFiles={selectedFiles}
        viewedFiles={viewedFilenames}
        hideViewed={hideViewed}
        commentCounts={commentCounts}
        pendingCommentCounts={pendingCommentCounts}
        noChangeFiles={noChangeFiles}
        onSelectFile={handleSelectFile}
        onToggleFileSelection={store.toggleFileSelection}
        onToggleViewed={store.toggleViewed}
        onToggleViewedMultiple={store.toggleViewedMultiple}
        onMarkFolderViewed={store.markFolderViewed}
        onCopyDiff={copyDiff}
        onCopyFile={copyFile}
        onCopyMainVersion={copyMainVersion}
      />
    </aside>
  );
});

// ============================================================================
// Read-Only Banner
// ============================================================================

const ReadOnlyBanner = memo(function ReadOnlyBanner() {
  const canWrite = useCanWrite();
  const { startDeviceAuth } = useAuth();

  if (canWrite) return null;

  return (
    <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center justify-between">
      <div className="flex items-center gap-2 text-sm">
        <Eye className="w-4 h-4 text-amber-500" />
        <span className="text-amber-200">
          <span className="font-medium">Read-only mode</span>
          <span className="text-amber-200/70 ml-1.5">
            – Sign in to comment and submit reviews
          </span>
        </span>
      </div>
      <button
        onClick={startDeviceAuth}
        className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 transition-colors"
      >
        Sign in with GitHub
      </button>
    </div>
  );
});

// ============================================================================
// Version / Commit Selector (sidebar)
// ============================================================================

/**
 * Stacked version/commit selectors for the file-list sidebar.
 * Self-contained: reads state and dispatches actions directly.
 * Returns null when there are no push versions (no interdiff context available).
 */
function VersionBar() {
  const store = usePRReviewStore();
  const pushVersions = usePRReviewSelector((s) => s.pushVersions);
  const commits = usePRReviewSelector((s) => s.commits);
  const commitsByVersion = usePRReviewSelector((s) => s.commitsByVersion);
  const compareToSha = usePRReviewSelector((s) => s.compareToSha);
  const compareToCommitSha = usePRReviewSelector((s) => s.compareToCommitSha);
  const selectedHeadSha = usePRReviewSelector((s) => s.selectedHeadSha);
  const selectedCommitSha = usePRReviewSelector((s) => s.selectedCommitSha);
  const selectedCommitDetails = usePRReviewSelector(
    (s) => s.selectedCommitDetails
  );
  const selectedParentSha = usePRReviewSelector((s) => s.selectedParentSha);
  const parentCommitMessages = usePRReviewSelector(
    (s) => s.parentCommitMessages
  );
  const versionDataLoaded = usePRReviewSelector((s) => s.versionDataLoaded);
  const reviews = usePRReviewSelector((s) => s.reviews);
  const currentUser = usePRReviewSelector((s) => s.currentUser);

  // Lazy-load version data when commits are available (deferred from loadPRData).
  // Deferring avoids a race: loadPRData populates commits asynchronously, and
  // loadVersionData needs actual commits to group into versions. Without this
  // guard, the mount-time effect fires before loadPRData finishes, leaving
  // commits empty and the last commit's version never created.
  useEffect(() => {
    if (!versionDataLoaded && commits.length > 0) {
      store.loadVersionData();
    }
  }, [versionDataLoaded, store, commits]);

  // Map of SHA → whether it's a merge commit (for showing correct icon in dropdowns)
  const isMergeCommit = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const c of commits) {
      map.set(c.sha, c.parents && c.parents.length > 1);
    }
    return map;
  }, [commits]);

  // Push version number of the most recent review submitted by the current user.
  // Used to annotate the version with "- Last review" in the selectors.
  const lastReviewedVersionNumber = useMemo(() => {
    if (!currentUser || pushVersions.length === 0) return null;
    let latest: Review | null = null;
    for (const r of reviews) {
      if (r.user?.login !== currentUser) continue;
      if (!r.submitted_at) continue;
      if (
        !latest ||
        new Date(r.submitted_at).getTime() >
          new Date(latest.submitted_at ?? 0).getTime()
      ) {
        latest = r;
      }
    }
    if (!latest?.commit_id) return null;
    return (
      pushVersions.find((v) => v.sha === latest.commit_id)?.version ?? null
    );
  }, [reviews, currentUser, pushVersions]);

  if (commits.length === 0) return null;

  const isViewingLatest = selectedHeadSha === null;
  const viewingVersion = pushVersions.find((v) => v.sha === selectedHeadSha);
  const viewingLabel = isViewingLatest
    ? `Latest`
    : viewingVersion
      ? `v${viewingVersion.version} (${getTimeAgo(new Date(viewingVersion.pushedAt))})${viewingVersion.version === lastReviewedVersionNumber ? " - Last review" : ""}`
      : `v?`;

  const selectedCommit = selectedCommitSha
    ? (commits.find((c) => c.sha === selectedCommitSha) ??
      selectedCommitDetails)
    : null;

  const compareToVersion = compareToSha
    ? pushVersions.find((v) => v.sha === compareToSha)
    : null;
  const compareToLabel = selectedParentSha
    ? `Parent #${(selectedCommit?.parents ?? []).findIndex((p) => p.sha === selectedParentSha) + 1}`
    : compareToVersion
      ? `v${compareToVersion.version} (${getTimeAgo(new Date(compareToVersion.pushedAt))})${compareToVersion.version === lastReviewedVersionNumber ? " - Last review" : ""}`
      : compareToSha
        ? "v?"
        : "Target";

  const compareToVersionCommits = compareToVersion
    ? (commitsByVersion.find((v) => v.version === compareToVersion.version)
        ?.commits ?? [])
    : [];
  const compareToCommit = compareToCommitSha
    ? compareToVersionCommits.find((c) => c.sha === compareToCommitSha)
    : null;

  // Ticket 50: the latest push version is never selectable in Compare to.
  const latestPushVersionNumber =
    pushVersions.length > 0 ? pushVersions[pushVersions.length - 1].version : 0;

  // Used by the ticket 51 safety net in the Compare to onClick to detect an
  // invalid range (Compare to >= Viewing). Latest counts as Infinity since it
  // is always newer than any numbered push version.
  const currentViewingVersionNumber = isViewingLatest
    ? Infinity
    : (viewingVersion?.version ?? Infinity);

  const sectionLabel =
    "text-[10px] uppercase tracking-wide text-muted-foreground/60 mb-0.5";
  const triggerBtn =
    "w-full flex items-center justify-between gap-1 px-2 py-1 rounded border border-border hover:bg-muted text-xs transition-colors truncate";

  return (
    <div className="mx-2 mt-2 space-y-2 pb-1">
      {/* ── Viewing (only when multiple push versions exist) ── */}
      {pushVersions.length > 0 && (
        <div>
          <div className={sectionLabel}>Viewing</div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className={triggerBtn}>
                <span className="truncate">{viewingLabel}</span>
                <ChevronDown className="w-3 h-3 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
              <DropdownMenuLabel className="text-xs">
                Viewing version
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => store.setSelectedHeadSha(null)}
                className="text-xs flex items-center justify-between"
              >
                <span>Latest</span>
                {isViewingLatest && <Check className="w-3 h-3 ml-2 shrink-0" />}
              </DropdownMenuItem>
              {[...pushVersions].reverse().map((pv) => (
                <DropdownMenuItem
                  key={pv.sha}
                  onClick={async () => {
                    // Ticket 51: if Viewing moves to a version at or before
                    // Compare to, shift Compare to to the version immediately
                    // before the new Viewing (or Target if none).
                    if (compareToSha) {
                      const compareToVersion = pushVersions.find(
                        (v) => v.sha === compareToSha
                      );
                      if (
                        compareToVersion &&
                        pv.version <= compareToVersion.version
                      ) {
                        const prevVersion = pushVersions.find(
                          (v) => v.version === pv.version - 1
                        );
                        await store.setCompareToSha(prevVersion?.sha ?? null);
                      }
                    }
                    store.setSelectedHeadSha(pv.sha);
                  }}
                  className="text-xs flex items-center justify-between"
                >
                  <span>
                    v{pv.version}{" "}
                    <span className="text-muted-foreground">
                      ({getTimeAgo(new Date(pv.pushedAt))})
                    </span>
                    {pv.version === lastReviewedVersionNumber && (
                      <span className="text-muted-foreground">
                        {" "}
                        - Last review
                      </span>
                    )}
                  </span>
                  {selectedHeadSha === pv.sha && (
                    <Check className="w-3 h-3 ml-2 shrink-0" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {/* ── Commit ── */}
      <div>
        <div className="flex items-center justify-between">
          <div className={sectionLabel}>Commit</div>
          {selectedCommitSha && (
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => store.navigateToPrevCommit()}
                className="flex items-center gap-0.5 px-1.5 py-0.5 text-xs rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                title="Previous commit ([)"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <kbd className="hidden sm:inline-block px-1 py-0.5 bg-muted/60 rounded text-[9px] font-mono">
                  [
                </kbd>
              </button>
              <span className="text-xs tabular-nums text-muted-foreground min-w-[3ch] text-center">
                {commits.findIndex((c) => c.sha === selectedCommitSha) + 1}/
                {commits.length}
              </span>
              <button
                onClick={() => store.navigateToNextCommit()}
                className="flex items-center gap-0.5 px-1.5 py-0.5 text-xs rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                title="Next commit (])"
              >
                <kbd className="hidden sm:inline-block px-1 py-0.5 bg-muted/60 rounded text-[9px] font-mono">
                  ]
                </kbd>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className={triggerBtn}>
              <span className="truncate">
                {selectedCommit
                  ? selectedCommit.commit.message.split("\n")[0]
                  : "Full branch"}
              </span>
              <ChevronDown className="w-3 h-3 shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-72">
            <DropdownMenuLabel className="text-xs">Commit</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => store.setSelectedCommitSha(null)}
              className="text-xs flex items-center justify-between"
            >
              <span>Full branch</span>
              {!selectedCommitSha && (
                <Check className="w-3 h-3 ml-2 shrink-0" />
              )}
            </DropdownMenuItem>
            {selectedCommit &&
              !commits.some((c) => c.sha === selectedCommitSha) && (
                <DropdownMenuItem className="text-xs flex items-center gap-2">
                  <GitCommit className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">
                    {selectedCommit.commit.message.split("\n")[0]}
                  </span>
                  <span className="font-mono text-muted-foreground shrink-0">
                    {selectedCommitSha?.slice(0, 7)}
                  </span>
                  <Check className="w-3 h-3 shrink-0" />
                </DropdownMenuItem>
              )}
            {commits.map((c) => (
              <DropdownMenuItem
                key={c.sha}
                onClick={() => store.setSelectedCommitSha(c.sha)}
                className="text-xs flex items-center gap-2"
              >
                {c.parents && c.parents.length > 1 ? (
                  <GitMerge className="w-3.5 h-3.5 shrink-0 text-purple-500" />
                ) : (
                  <GitCommit className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="flex-1 truncate">
                  {c.commit.message.split("\n")[0]}
                </span>
                <span className="font-mono text-muted-foreground shrink-0">
                  {c.sha.slice(0, 7)}
                </span>
                {selectedCommitSha === c.sha && (
                  <Check className="w-3 h-3 shrink-0" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* ── Compare to (only when multiple push versions exist) ── */}
      {pushVersions.length > 0 && (
        <div>
          <div className={sectionLabel}>Compare to</div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className={triggerBtn}>
                <span className="truncate">{compareToLabel}</span>
                <ChevronDown className="w-3 h-3 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-48">
              <DropdownMenuLabel className="text-xs">
                Compare to
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {selectedCommit &&
                selectedCommit.parents &&
                selectedCommit.parents.length > 1 &&
                selectedCommit.parents.map((p, i) => (
                  <DropdownMenuItem
                    key={p.sha}
                    onClick={() => store.setSelectedParentSha(p.sha)}
                    className="text-xs flex items-center gap-2"
                  >
                    {isMergeCommit.get(p.sha) ? (
                      <GitMerge className="w-3.5 h-3.5 shrink-0 text-purple-500" />
                    ) : (
                      <GitCommit className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <div className="flex flex-col">
                      <span className="truncate">
                        Parent #{i + 1}{" "}
                        <span className="font-mono text-muted-foreground">
                          {p.sha.slice(0, 7)}
                        </span>
                      </span>
                      {parentCommitMessages[p.sha] && (
                        <span className="text-muted-foreground/70">
                          {parentCommitMessages[p.sha]}
                        </span>
                      )}
                    </div>
                    {i === 0 && !selectedParentSha && (
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        (default)
                      </span>
                    )}
                    {selectedParentSha === p.sha && (
                      <Check className="w-3 h-3 ml-2 shrink-0" />
                    )}
                  </DropdownMenuItem>
                ))}
              {selectedCommit &&
                selectedCommit.parents &&
                selectedCommit.parents.length > 1 && <DropdownMenuSeparator />}
              <DropdownMenuItem
                onClick={() => store.setCompareToSha(null)}
                className="text-xs flex items-center justify-between"
              >
                <span>Target</span>
                {!compareToSha && !selectedParentSha && (
                  <Check className="w-3 h-3 ml-2 shrink-0" />
                )}
              </DropdownMenuItem>
              {[...pushVersions]
                .reverse()
                // Ticket 50: the latest push version is never selectable.
                .filter((pv) => pv.version < latestPushVersionNumber)
                .map((pv) => (
                  <DropdownMenuItem
                    key={pv.sha}
                    onClick={async () => {
                      // Ticket 51: if Compare to moves to >= Viewing, shift
                      // Viewing to the version immediately after Compare to
                      // (or Latest if none).
                      if (pv.version >= currentViewingVersionNumber) {
                        const nextVersion = pushVersions.find(
                          (v) => v.version === pv.version + 1
                        );
                        await store.setSelectedHeadSha(
                          nextVersion?.sha ?? null
                        );
                      }
                      store.setCompareToSha(pv.sha);
                    }}
                    className="text-xs flex items-center justify-between"
                  >
                    <span>
                      v{pv.version}{" "}
                      <span className="text-muted-foreground">
                        ({getTimeAgo(new Date(pv.pushedAt))})
                      </span>
                      {pv.version === lastReviewedVersionNumber && (
                        <span className="text-muted-foreground">
                          {" "}
                          - Last review
                        </span>
                      )}
                    </span>
                    {compareToSha === pv.sha && (
                      <Check className="w-3 h-3 ml-2 shrink-0" />
                    )}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Compare-to commit — nested below when a specific commit (not full branch) is selected */}
          {compareToSha && selectedCommitSha !== null && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="mt-1 ml-3 w-[calc(100%-0.75rem)] flex items-center justify-between gap-1 px-2 py-1 rounded border border-border hover:bg-muted text-xs transition-colors text-muted-foreground">
                  <span className="truncate">
                    {compareToCommit
                      ? compareToCommit.commit.message.split("\n")[0]
                      : "— none —"}
                  </span>
                  <ChevronDown className="w-3 h-3 shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuLabel className="text-xs">
                  Commit in {compareToLabel}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {compareToVersionCommits.map((c) => (
                  <DropdownMenuItem
                    key={c.sha}
                    onClick={() => store.setCompareToCommitSha(c.sha)}
                    className="text-xs flex items-center gap-2"
                  >
                    {c.parents && c.parents.length > 1 ? (
                      <GitMerge className="w-3.5 h-3.5 shrink-0 text-purple-500" />
                    ) : (
                      <GitCommit className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex-1 truncate">
                      {c.commit.message.split("\n")[0]}
                    </span>
                    <span className="font-mono text-muted-foreground shrink-0">
                      {c.sha.slice(0, 7)}
                    </span>
                    {compareToCommitSha === c.sha && (
                      <Check className="w-3 h-3 shrink-0" />
                    )}
                  </DropdownMenuItem>
                ))}
                {compareToVersionCommits.length === 0 && (
                  <DropdownMenuItem
                    disabled
                    className="text-xs text-muted-foreground"
                  >
                    No commits available
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      {/* Reset to defaults */}
      {(selectedHeadSha !== null ||
        selectedCommitSha !== null ||
        compareToSha !== null ||
        selectedParentSha !== null) && (
        <button
          onClick={() => store.resetVersionSelectors()}
          className="w-full text-xs text-muted-foreground hover:text-foreground py-1 px-2 rounded border border-border hover:bg-muted transition-colors"
        >
          Reset to defaults
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Diff Panel (Main Content)
// ============================================================================

const DiffPanel = memo(function DiffPanel() {
  const store = usePRReviewStore();
  const canWrite = useCanWrite();
  const pr = usePRReviewSelector((s) => s.pr);
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const files = usePRReviewSelector((s) => s.files);
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const viewedFilenames = usePRReviewSelector((s) => s.viewedFilenames);
  const selectedFiles = usePRReviewSelector((s) => s.selectedFiles);
  const showOverview = usePRReviewSelector((s) => s.showOverview);
  const diffViewMode = usePRReviewSelector((s) => s.diffViewMode);
  const wordWrap = usePRReviewSelector((s) => s.wordWrap);
  const conversationsSidebarOpen = usePRReviewSelector(
    (s) => s.conversationsSidebarOpen
  );
  const commentsHidden = usePRReviewSelector((s) => s.commentsHidden);
  const pushVersions = usePRReviewSelector((s) => s.pushVersions);
  const selectedHeadSha = usePRReviewSelector((s) => s.selectedHeadSha);
  const selectedCommitSha = usePRReviewSelector((s) => s.selectedCommitSha);

  const currentFile = useCurrentFile();
  const currentDiff = useCurrentDiff();
  const isLoading = useIsCurrentFileLoading();
  const conversationsCount = useConversationsSidebarCount();

  // Keep the last diff around while a newly selected file loads, so
  // DiffViewer stays mounted (preserving in-progress search state) and the
  // view shows the previous content dimmed under a loading overlay instead
  // of unmounting.
  const lastDiffRef = useRef<{ filename: string; diff: LoadedDiff } | null>(
    null
  );
  if (currentDiff && selectedFile) {
    lastDiffRef.current = { filename: selectedFile, diff: currentDiff };
  }
  const displayed = currentDiff
    ? { filename: selectedFile ?? "", diff: currentDiff }
    : lastDiffRef.current;
  const isSwitchingFiles = isLoading && !currentDiff && !!displayed;

  const displayFiles = useMemo(() => {
    if (!selectedCommitSha) return files;
    const commitFile: PullRequestFile = {
      filename: ":commit",
      sha: null,
      status: "modified",
      additions: 0,
      deletions: 0,
      changes: 0,
    } as PullRequestFile;
    return [commitFile, ...files];
  }, [files, selectedCommitSha]);

  const currentIndex = selectedFile
    ? displayFiles.findIndex((f) => f.filename === selectedFile)
    : -1;

  // Show overview panel
  if (showOverview) {
    return (
      <main className="flex-1 overflow-hidden flex flex-col">
        <ReadOnlyBanner />
        <PROverview />
      </main>
    );
  }

  return (
    <main className="flex-1 overflow-hidden flex flex-col">
      <ReadOnlyBanner />

      {currentFile ? (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Sticky file header with navigation */}
          <div className="shrink-0 border-b border-border bg-muted/50 backdrop-blur-sm z-20">
            <div className="px-3 py-1.5">
              <FileHeader
                file={currentFile}
                isViewed={viewedFilenames.has(currentFile.filename)}
                onToggleViewed={() => store.toggleViewed(currentFile.filename)}
                currentIndex={currentIndex}
                totalFiles={displayFiles.length}
                onPrevFile={() => store.navigateToPrevUnviewedFile()}
                onNextFile={() => store.navigateToNextUnviewedFile()}
                diffViewMode={diffViewMode}
                onToggleDiffViewMode={() => store.toggleDiffViewMode()}
                wordWrap={wordWrap}
                onToggleWordWrap={() => store.toggleWordWrap()}
                conversationsSidebarOpen={conversationsSidebarOpen}
                onToggleConversationsSidebar={() =>
                  store.toggleConversationsSidebar()
                }
                conversationsCount={conversationsCount}
                commentsHidden={commentsHidden}
                onToggleComments={() => store.toggleComments()}
                selectedVersion={
                  selectedHeadSha
                    ? pushVersions.find((v) => v.sha === selectedHeadSha)
                        ?.version
                    : undefined
                }
                owner={owner}
                repo={repo}
                headSha={selectedHeadSha ?? pr.head.sha}
              />
            </div>
          </div>

          {/* Diff content + optional conversations sidebar */}
          <div className="flex-1 min-h-0 flex flex-row">
            {/* Scrollable diff content - DiffViewer is Pierre's virtualized CodeView */}
            <div className="flex-1 min-h-0 flex flex-col">
              {currentDiff?.error ? (
                <div role="alert" className="p-4 text-sm text-muted-foreground">
                  {currentDiff.error}
                </div>
              ) : displayed && displayed.diff.fileDiff.hunks.length > 0 ? (
                <div className="relative flex flex-1 min-h-0 flex-col">
                  <DiffViewer
                    diff={displayed.diff}
                    filename={displayed.filename}
                    viewMode={diffViewMode}
                    wordWrap={wordWrap}
                  />
                  {isSwitchingFiles && (
                    <div className="absolute inset-0 z-10 bg-background/70">
                      <DiffSkeleton />
                    </div>
                  )}
                </div>
              ) : isLoading || (currentFile.patch && !currentDiff) ? (
                // Show skeleton if loading OR if file has patch but diff isn't ready yet
                <DiffSkeleton />
              ) : (
                <div className="p-4 text-sm text-muted-foreground text-center flex-1 flex items-center justify-center">
                  {!currentFile.patch
                    ? currentFile.status === "removed"
                      ? "File deleted"
                      : currentFile.status === "renamed"
                        ? "File renamed without changes"
                        : currentFile.sha ===
                            "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
                          ? // Git's empty-blob SHA: the file exists but has no content
                            "Empty file"
                          : "Binary file or file too large to display"
                    : "No changes to display"}
                </div>
              )}
            </div>

            {conversationsSidebarOpen && <ConversationsSidebar />}
          </div>

          <KeybindsBar />
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex items-center justify-center flex-1 text-muted-foreground">
            Select a file to view changes
          </div>
          <KeybindsBar />
        </div>
      )}
    </main>
  );
});

// ============================================================================
// Keybinds Bar
// ============================================================================

const KeybindsBar = memo(function KeybindsBar() {
  const gotoLineMode = usePRReviewSelector((s) => s.gotoLineMode);
  const gotoLineInput = usePRReviewSelector((s) => s.gotoLineInput);
  const gotoLineSide = usePRReviewSelector((s) => s.gotoLineSide);
  const focusedLine = usePRReviewSelector((s) => s.focusedLine);
  const selectionAnchor = usePRReviewSelector((s) => s.selectionAnchor);
  const focusedCommentId = usePRReviewSelector((s) => s.focusedCommentId);
  const focusedPendingCommentId = usePRReviewSelector(
    (s) => s.focusedPendingCommentId
  );
  const focusedGapIndex = usePRReviewSelector((s) => s.focusedGapIndex);
  const commentingOnLine = usePRReviewSelector((s) => s.commentingOnLine);
  const pendingCommentsCount = usePRReviewSelector(
    (s) => s.pendingComments.length
  );

  const showEscape =
    gotoLineMode ||
    focusedLine ||
    focusedCommentId ||
    focusedPendingCommentId ||
    focusedGapIndex !== null ||
    commentingOnLine;

  const leftRef = useRef<HTMLDivElement>(null);
  const [tooNarrow, setTooNarrow] = useState(false);

  useLayoutEffect(() => {
    const el = leftRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setTooNarrow(el.scrollWidth > el.clientWidth);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [tooNarrow]);

  useEffect(() => {
    if (!tooNarrow) return;
    const onResize = () => setTooNarrow(false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [tooNarrow]);

  if (tooNarrow) return null;

  return (
    <div
      className={cn(
        "shrink-0 border-t border-border px-3 py-2 min-h-[36px]",
        gotoLineMode && "bg-blue-500/10",
        (focusedCommentId || focusedPendingCommentId) && "bg-yellow-500/10",
        commentingOnLine && "bg-green-500/10",
        focusedGapIndex !== null && "bg-blue-500/10",
        !gotoLineMode &&
          !focusedCommentId &&
          !focusedPendingCommentId &&
          !commentingOnLine &&
          focusedGapIndex === null &&
          "bg-card/50"
      )}
    >
      <div
        ref={leftRef}
        className="flex items-center justify-between text-xs whitespace-nowrap"
      >
        <div className="flex items-center gap-4">
          {gotoLineMode ? (
            <>
              <span className="flex items-center gap-2">
                <span className="px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded text-xs font-medium">
                  GOTO
                </span>
                <span
                  className={cn(
                    "px-1.5 py-0.5 rounded text-xs font-medium",
                    gotoLineSide === "new"
                      ? "bg-green-500/20 text-green-400"
                      : "bg-orange-500/20 text-orange-400"
                  )}
                >
                  {gotoLineSide === "new" ? "new" : "old"}
                </span>
                <span className="font-mono text-blue-400">
                  {gotoLineInput || "..."}
                </span>
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="Tab" size="xs" /> toggle side
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="Enter" size="xs" /> jump
              </span>
            </>
          ) : commentingOnLine ? (
            <>
              <span className="px-2 py-0.5 bg-green-500/20 text-green-400 rounded text-xs font-medium">
                COMMENT
              </span>
              <span className="font-mono text-green-400">
                L
                {commentingOnLine.startLine
                  ? `${commentingOnLine.startLine}-`
                  : ""}
                {commentingOnLine.line}
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <KeycapGroup keys={["cmd", "Enter"]} size="xs" /> submit
              </span>
            </>
          ) : focusedPendingCommentId ? (
            <>
              <span className="px-2 py-0.5 bg-yellow-500/20 text-yellow-400 rounded text-xs font-medium">
                PENDING
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="e" size="xs" /> edit
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="d" size="xs" /> delete
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="up" size="xs" /> back to line
              </span>
            </>
          ) : focusedCommentId ? (
            <>
              <span className="px-2 py-0.5 bg-yellow-500/20 text-yellow-400 rounded text-xs font-medium">
                COMMENT
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="r" size="xs" /> reply
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="e" size="xs" /> edit
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="d" size="xs" /> delete
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="up" size="xs" /> back to line
              </span>
            </>
          ) : focusedGapIndex !== null ? (
            <>
              <span className="px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded text-xs font-medium">
                EXPAND
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="Enter" size="xs" /> expand hidden lines
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <KeycapGroup keys={["up", "down"]} size="xs" /> navigate
              </span>
            </>
          ) : focusedLine ? (
            <>
              <span className="font-mono text-blue-400">
                {selectionAnchor
                  ? `L${Math.min(focusedLine, selectionAnchor)}-${Math.max(focusedLine, selectionAnchor)}`
                  : `L${focusedLine}`}
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="c" size="xs" /> comment
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="down" size="xs" /> view comments
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="Shift" size="xs" />
                <KeycapGroup keys={["up", "down"]} size="xs" /> select range
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <KeycapGroup keys={["cmd", "up", "down"]} size="xs" /> jump 10
              </span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <KeycapGroup keys={["cmd", "k"]} size="xs" /> search files
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <KeycapGroup keys={["up", "down"]} size="xs" /> select line
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <KeycapGroup keys={["cmd", "up", "down"]} size="xs" /> jump 10
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="g" size="xs" /> goto line
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="[" size="xs" />
                <Keycap keyName="]" size="xs" /> prev/next commit
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="j" size="xs" />
                <Keycap keyName="k" size="xs" /> prev/next file
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Keycap keyName="v" size="xs" /> mark viewed
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-3">
          {pendingCommentsCount > 0 && (
            <span className="text-yellow-400 text-xs">
              {pendingCommentsCount} pending comment
              {pendingCommentsCount !== 1 ? "s" : ""}
            </span>
          )}
          {showEscape && (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Keycap keyName="Esc" size="xs" />
              {gotoLineMode ? "cancel" : commentingOnLine ? "cancel" : "clear"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

// ============================================================================
// Submit Review Dropdown (GitHub-style)
// ============================================================================

const SubmitReviewDropdown = memo(function SubmitReviewDropdown() {
  const store = usePRReviewStore();
  const { submitReview: submitStoredReview } = useReviewActions();
  const { removePendingComment } = useCommentActions();

  const pendingComments = usePRReviewSelector((s) => s.pendingComments);
  const reviewBodyRef = useRef<{ flush: () => void }>(null);
  const [hasReviewBody, setHasReviewBody] = useState(
    () => !!store.getSnapshot().reviewBody.trim()
  );
  const submitReview = useCallback(
    (event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES") => {
      reviewBodyRef.current?.flush();
      return submitStoredReview(event);
    },
    [submitStoredReview]
  );
  const submitting = usePRReviewSelector((s) => s.submittingReview);
  const pr = usePRReviewSelector((s) => s.pr);
  const currentUser = usePRReviewSelector((s) => s.currentUser);
  const viewerPermission = usePRReviewSelector((s) => s.viewerPermission);

  const [reviewType, setReviewType] = useState<
    "COMMENT" | "APPROVE" | "REQUEST_CHANGES"
  >("COMMENT");
  const [isOpen, setIsOpen] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [openedViaKeyboard, setOpenedViaKeyboard] = useState(false);

  // Listen for global event to open the submit review dropdown
  useEffect(() => {
    const handleOpenSubmitReview = () => {
      setOpenedViaKeyboard(true);
      setIsOpen(true);
    };
    window.addEventListener(
      "pr-review:open-submit-review",
      handleOpenSubmitReview
    );
    return () =>
      window.removeEventListener(
        "pr-review:open-submit-review",
        handleOpenSubmitReview
      );
  }, []);

  // Alt+S to approve without comment
  useEffect(() => {
    const handler = () => submitReview("APPROVE");
    window.addEventListener("pr-review:approve", handler);
    return () => window.removeEventListener("pr-review:approve", handler);
  }, [submitReview]);

  // Reset openedViaKeyboard when dropdown closes
  useEffect(() => {
    if (!isOpen) {
      setOpenedViaKeyboard(false);
    }
  }, [isOpen]);

  // Check if current user is the PR author (can't approve/request changes on own PR)
  const isAuthor = currentUser !== null && pr.user.login === currentUser;

  // Check if viewer has write access (ADMIN, MAINTAIN, or WRITE can approve/request_changes)
  // TRIAGE and READ permissions are limited to commenting only
  const canApproveOrRequestChanges =
    viewerPermission === "ADMIN" ||
    viewerPermission === "MAINTAIN" ||
    viewerPermission === "WRITE";

  // Group pending comments by file
  // Metadata comments (on :commit) are always grouped under ":commit"
  // regardless of the stored path, to handle both new and old pending comments.
  const commentsByFile = useMemo(() => {
    const grouped = new Map<string, LocalPendingComment[]>();
    for (const comment of pendingComments) {
      const filePath = isMetadataComment(comment.body)
        ? ":commit"
        : comment.path;
      const existing = grouped.get(filePath) || [];
      existing.push(comment);
      grouped.set(filePath, existing);
    }
    return grouped;
  }, [pendingComments]);

  const pendingCount = pendingComments.length;

  const handleSubmit = useCallback(async () => {
    await submitReview(reviewType);
    setIsOpen(false);
  }, [submitReview, reviewType]);

  // Ctrl/Cmd+Enter to submit review when dropdown is open
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        // Check if submit is allowed
        const canSubmit =
          !submitting &&
          !(reviewType === "COMMENT" && pendingCount === 0 && !hasReviewBody);
        if (canSubmit) {
          handleSubmit();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    isOpen,
    submitting,
    reviewType,
    pendingCount,
    hasReviewBody,
    handleSubmit,
  ]);

  const handleJumpToComment = useCallback(
    (comment: LocalPendingComment) => {
      const filePath = isMetadataComment(comment.body)
        ? ":commit"
        : comment.path;
      store.selectFile(filePath);
      // Small delay to let the file load, then focus the pending comment
      setTimeout(() => {
        store.setFocusedPendingCommentId(comment.id);
      }, 100);
      setIsOpen(false);
    },
    [store]
  );

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors"
          aria-label="Submit review"
          title="Submit review"
          onPointerDown={(e) => {
            if (e.altKey) {
              e.preventDefault();
              e.stopPropagation();
              submitReview("APPROVE");
            }
          }}
        >
          {/* The label costs ~90px, which on a phone left the PR title two
              characters wide. The shortcut hint below carries the meaning
              there, and the accessible name now comes from aria-label rather
              than this text. */}
          <span className="hidden sm:inline">Submit review</span>
          {pendingCount > 0 && (
            <span className="px-1 py-0.5 text-[10px] bg-green-500/50 rounded">
              {pendingCount}
            </span>
          )}
          <span className="px-1 py-0.5 text-[10px] bg-green-500/50 rounded font-mono">
            S
          </span>
          <ChevronsUpDown className="w-3.5 h-3.5 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[450px]"
        // This menu is non-modal, so it is the one surface where an extension's
        // event reaches the document and reads as an outside click. Dismissal
        // then happens twice over — once for the pointerdown, once for the
        // focus the suggestion takes — so both paths need ignoring. The
        // original event is used because its composed path still sees into the
        // shadow root, which the retargeted custom event does not.
        onPointerDownOutside={(event) => {
          if (isForeignUiEvent(event.detail.originalEvent)) {
            event.preventDefault();
          }
        }}
        onFocusOutside={(event) => {
          if (isForeignUiEvent(event.detail.originalEvent)) {
            event.preventDefault();
          }
        }}
      >
        <DropdownMenuLabel className="font-semibold">
          Finish your review
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* Review body */}
        <div className="p-3" onClick={(e) => e.stopPropagation()}>
          <ReviewBodyEditor
            ref={reviewBodyRef}
            onHasBodyChange={setHasReviewBody}
            autoFocus={openedViaKeyboard}
          />
        </div>

        {/* Pending comments by file */}
        {pendingCount > 0 && (
          <div className="px-3 pb-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground mb-2">
              <span className="font-medium">
                {pendingCount} pending comment{pendingCount !== 1 ? "s" : ""}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  pendingComments.forEach((c) => removePendingComment(c.id));
                }}
                className="text-destructive hover:underline"
              >
                Clear all
              </button>
            </div>

            {/* File list with comments */}
            <div className="max-h-[200px] overflow-y-auto space-y-1 themed-scrollbar">
              {Array.from(commentsByFile.entries()).map(
                ([filePath, comments]) => {
                  const fileName =
                    filePath === ":commit"
                      ? "Commit metadata"
                      : filePath.split("/").pop() || filePath;
                  const isExpanded = expandedFile === filePath;

                  return (
                    <div
                      key={filePath}
                      className="rounded-md border border-border/50 overflow-hidden"
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedFile(isExpanded ? null : filePath);
                        }}
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-muted/50 transition-colors"
                      >
                        {isExpanded ? (
                          <ChevronDown className="w-3 h-3 shrink-0" />
                        ) : (
                          <ChevronRight className="w-3 h-3 shrink-0" />
                        )}
                        <FileCode className="w-3 h-3 shrink-0 text-muted-foreground" />
                        <span className="font-mono truncate flex-1 text-left">
                          {fileName}
                        </span>
                        <span className="px-1.5 py-0.5 bg-yellow-500/20 text-yellow-500 rounded text-[10px]">
                          {comments.length}
                        </span>
                      </button>

                      {isExpanded && (
                        <div className="border-t border-border/50 bg-muted/30">
                          {comments.map((comment) => (
                            <button
                              key={comment.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleJumpToComment(comment);
                              }}
                              className="w-full flex items-start gap-2 px-3 py-2 text-xs hover:bg-muted/50 transition-colors text-left border-b border-border/30 last:border-b-0"
                            >
                              <span className="font-mono text-muted-foreground shrink-0">
                                {isMetadataComment(comment.body)
                                  ? (() => {
                                      const info = parseCommitMetadataMarker(
                                        comment.body ?? ""
                                      );
                                      return `L${info ? info.line : comment.line}`;
                                    })()
                                  : `L${comment.start_line ? `${comment.start_line}-` : ""}${comment.line}`}
                              </span>
                              <span className="text-foreground/80 line-clamp-2 flex-1">
                                {stripReviewGroupMarker(
                                  stripCommitMetadataPrefix(comment.body)
                                )}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                }
              )}
            </div>
          </div>
        )}

        <DropdownMenuSeparator />

        {/* Review type radio options */}
        <div className="px-3 py-2">
          <RadioGroup
            value={reviewType}
            onValueChange={(v) => setReviewType(v as typeof reviewType)}
            className="gap-2"
          >
            <label className="flex items-start gap-3 cursor-pointer group">
              <RadioGroupItem value="COMMENT" className="mt-0.5" />
              <div className="flex flex-col gap-0.5">
                <span className="font-medium text-sm">Comment</span>
                <span className="text-xs text-muted-foreground">
                  Submit general feedback without explicit approval.
                </span>
              </div>
            </label>

            {!isAuthor && canApproveOrRequestChanges && (
              <>
                <label className="flex items-start gap-3 cursor-pointer group">
                  <RadioGroupItem value="APPROVE" className="mt-0.5" />
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-sm text-green-400">
                      Approve
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Submit feedback and approve merging these changes.
                    </span>
                  </div>
                </label>

                <label className="flex items-start gap-3 cursor-pointer group">
                  <RadioGroupItem value="REQUEST_CHANGES" className="mt-0.5" />
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-sm text-amber-400">
                      Request changes
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Submit feedback suggesting changes.
                    </span>
                  </div>
                </label>
              </>
            )}

            {/* Show explanation when user cannot approve */}
            {!isAuthor && !canApproveOrRequestChanges && viewerPermission && (
              <div className="flex items-start gap-2 px-1 py-2 text-xs text-muted-foreground bg-muted/30 rounded-md">
                <ExternalLink className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  You can only comment on this PR. The{" "}
                  <span className="font-medium">
                    {pr.base.repo.owner.login}
                  </span>{" "}
                  organization has OAuth app restrictions enabled.{" "}
                  <a
                    href="https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/approving-oauth-apps-for-your-organization"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Learn more
                  </a>
                </span>
              </div>
            )}
          </RadioGroup>
        </div>

        <DropdownMenuSeparator />

        {/* Submit buttons */}
        <div className="p-2 flex justify-end gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsOpen(false);
            }}
            className="px-2 py-1 text-xs rounded-md hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleSubmit();
            }}
            disabled={
              submitting ||
              (reviewType === "COMMENT" && pendingCount === 0 && !hasReviewBody)
            }
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md transition-colors disabled:opacity-50",
              reviewType === "APPROVE" &&
                "bg-green-500/20 text-green-400 hover:bg-green-500/30 border border-green-500/30",
              reviewType === "REQUEST_CHANGES" &&
                "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 border border-amber-500/30",
              reviewType === "COMMENT" &&
                "bg-primary text-primary-foreground hover:bg-primary/90"
            )}
          >
            {submitting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : reviewType === "APPROVE" ? (
              <Check className="w-3.5 h-3.5" />
            ) : reviewType === "REQUEST_CHANGES" ? (
              <XCircle className="w-3.5 h-3.5" />
            ) : (
              <MessageSquare className="w-3.5 h-3.5" />
            )}
            Submit review
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const ReviewBodyEditor = memo(function ReviewBodyEditor({
  ref,
  onHasBodyChange,
  autoFocus,
}: {
  ref: React.Ref<{ flush: () => void }>;
  onHasBodyChange: (hasBody: boolean) => void;
  autoFocus: boolean;
}) {
  const store = usePRReviewStore();
  const saved = usePRReviewSelector((s) => s.reviewBody);
  const submitting = usePRReviewSelector((s) => s.submittingReview);
  const [body, setBody, flush] = useDraft(saved, store.setReviewBody);
  React.useImperativeHandle(ref, () => ({ flush }), [flush]);
  const hasBody = !!body.trim();
  useEffect(() => onHasBodyChange(hasBody), [hasBody, onHasBodyChange]);
  return (
    <div onBlurCapture={flush}>
      <MarkdownEditor
        value={body}
        onChange={setBody}
        placeholder="Leave a comment"
        minHeight="80px"
        autoFocus={autoFocus}
        disabled={submitting}
      />
    </div>
  );
});

// ============================================================================
// Skeleton Components
// ============================================================================

function PRReviewSkeleton() {
  // Check URL hash to determine which skeleton to show
  // If hash contains file=, user navigated directly to a file
  const hash = window.location.hash;
  const showFileSkeleton = hash.includes("file=");

  return (
    <div className="flex flex-col h-full">
      {/* Header skeleton - single row matching PRHeader */}
      <div className="shrink-0 border-b border-border bg-card/30 px-2 sm:px-4 py-2">
        <div className="flex items-center gap-2 sm:gap-3">
          <Skeleton className="h-6 w-16 rounded-full" />
          <Skeleton className="h-4 w-24 hidden sm:block" />
          <Skeleton className="h-5 flex-1 max-w-md" />
          <Skeleton className="h-5 w-5 rounded-full" />
          <Skeleton className="h-4 w-16 hidden sm:block" />
          <Skeleton className="h-4 w-4" />
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* File panel skeleton */}
        <aside className="w-64 border-r border-border flex flex-col overflow-hidden shrink-0">
          <div className="mx-2 my-2 flex items-center gap-1.5">
            <Skeleton className="flex-1 h-8" />
            <Skeleton className="w-8 h-8" />
          </div>
          <Skeleton className="mx-2 mb-1 h-8" />
          <div className="border-t border-border/50 mt-1" />
          <div className="flex-1 p-2 space-y-1">
            {[70, 55, 80, 45, 65, 90, 50, 75, 60, 85, 40, 70].map(
              (width, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1">
                  <Skeleton className="w-4 h-4" />
                  <Skeleton className="h-4" style={{ width: `${width}%` }} />
                </div>
              )
            )}
          </div>
        </aside>

        {/* Main content skeleton - show diff or overview based on URL hash */}
        <main className="flex-1 overflow-hidden flex flex-col">
          {showFileSkeleton ? <DiffSkeleton /> : <OverviewPanelSkeleton />}
        </main>
      </div>
    </div>
  );
}

function OverviewPanelSkeleton() {
  return (
    <div className="flex-1 overflow-auto bg-background">
      {/* Tabs skeleton */}
      <div className="border-b border-border">
        <div className="max-w-[1280px] mx-auto px-6">
          <div className="flex items-center gap-4 py-2">
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-20" />
          </div>
        </div>
      </div>

      {/* Main Content skeleton */}
      <div className="max-w-[1280px] mx-auto px-6 py-6">
        <div className="flex gap-6">
          {/* Left Column */}
          <div className="flex-1 min-w-0 space-y-4">
            {/* PR Description skeleton */}
            <div className="border border-border rounded-md overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-card/50">
                <Skeleton className="w-5 h-5 rounded-full" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-20" />
              </div>
              <div className="p-4 space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-[90%]" />
                <Skeleton className="h-4 w-[75%]" />
                <Skeleton className="h-4 w-[85%]" />
                <Skeleton className="h-4 w-[60%]" />
              </div>
            </div>

            {/* Timeline items skeleton */}
            {Array.from({ length: 2 }).map((_, i) => (
              <div
                key={i}
                className="border border-border rounded-md overflow-hidden"
              >
                <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-card/50">
                  <Skeleton className="w-5 h-5 rounded-full" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <div className="p-4 space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-[90%]" />
                </div>
              </div>
            ))}

            {/* Merge section skeleton */}
            <div className="border border-border rounded-md overflow-hidden">
              {Array.from({ length: 2 }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 p-4 border-b border-border last:border-b-0"
                >
                  <Skeleton className="w-5 h-5 rounded-full" />
                  <div className="flex-1 space-y-1">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-64" />
                  </div>
                </div>
              ))}
              <div className="p-4">
                <Skeleton className="h-10 w-full" />
              </div>
            </div>
          </div>

          {/* Right Column - Sidebar skeleton */}
          <div className="w-[296px] shrink-0 space-y-4 hidden lg:block">
            {/* Reviewers */}
            <div className="pb-3 border-b border-border">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-muted-foreground">
                  Reviewers
                </span>
                <Skeleton className="w-4 h-4" />
              </div>
              <div className="space-y-2">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Skeleton className="w-5 h-5 rounded-full" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                ))}
              </div>
            </div>

            {/* Labels */}
            <div className="pb-3 border-b border-border">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-muted-foreground">
                  Labels
                </span>
                <Skeleton className="w-4 h-4" />
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-5 w-16 rounded-full" />
                ))}
              </div>
            </div>

            {/* Participants */}
            <div className="pb-3 border-b border-border">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-muted-foreground">
                  Participants
                </span>
              </div>
              <div className="flex items-center gap-1">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="w-6 h-6 rounded-full" />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Deterministic widths for skeleton lines to avoid re-render flicker
const SKELETON_LINE_WIDTHS = [
  65, 45, 80, 30, 55, 70, 40, 85, 50, 60, 75, 35, 90, 45, 55, 70, 25, 80, 60,
  50,
];

function DiffSkeleton() {
  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="font-mono text-[0.8rem]">
          {/* Hunk header skeleton */}
          <div className="bg-muted/50 px-4 py-2 border-b border-border">
            <Skeleton className="h-4 w-48" />
          </div>

          {/* Diff lines skeleton */}
          {SKELETON_LINE_WIDTHS.map((width, i) => (
            <DiffLineSkeleton
              key={i}
              type={i % 7 === 3 ? "add" : i % 7 === 5 ? "remove" : "normal"}
              width={width}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DiffLineSkeleton({
  type = "normal",
  width,
}: {
  type?: "add" | "remove" | "normal";
  width: number;
}) {
  const bgClass =
    type === "add"
      ? "bg-green-500/5"
      : type === "remove"
        ? "bg-orange-500/5"
        : "";

  return (
    <div className={cn("flex h-5 min-h-5", bgClass)}>
      <div className="w-1 shrink-0" />
      <div className="w-10 shrink-0 flex items-center justify-end pr-2">
        <Skeleton className="h-3 w-6" />
      </div>
      <div className="w-10 shrink-0 border-r border-border/30 flex items-center justify-end pr-2">
        <Skeleton className="h-3 w-6" />
      </div>
      <div className="flex-1 pl-2 flex items-center">
        <Skeleton className="h-3" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}
