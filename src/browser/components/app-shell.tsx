import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  X,
  Home as HomeIcon,
  GitMerge,
  GitPullRequest,
  ExternalLink,
  Github,
} from "lucide-react";
import { cn } from "../cn";
import {
  useTabContext,
  useOpenPRReviewTab,
  type Tab,
  type TabStatus,
} from "../contexts/tabs";
import { useGitHubStore, type PREnrichment } from "../contexts/github";
import { getLastViewed, setLastViewed } from "../lib/waiting-prs";
import {
  getEnabled as notifsEnabled,
  sendNotification,
  getNotifiedAt,
  setNotifiedAt,
} from "../lib/notifications";
import { Home } from "./home";
import { PRReviewContent } from "./pr-review";
import { UserMenuButton } from "./welcome-dialog";
import { useAuth } from "../contexts/auth";
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from "../ui/hover-card";
import { version } from "../../../package.json";

// ============================================================================
// App Shell - Tab-based Layout
// ============================================================================

export function AppShell() {
  const {
    tabs,
    activeTabId,
    activeTab,
    setActiveTab,
    closeTab,
    openTab,
    getExistingPRTab,
    markTabUpdated,
    clearTabUpdated,
  } = useTabContext();
  const { isAuthenticated } = useAuth();
  const params = useParams<{ owner: string; repo: string; number: string }>();
  const navigate = useNavigate();
  const githubStore = useGitHubStore();

  // URL is the source of truth - sync URL → Tab
  useEffect(() => {
    if (params.owner && params.repo && params.number) {
      const owner = params.owner;
      const repo = params.repo;
      const number = parseInt(params.number, 10);
      const expectedTabId = `pr-${owner}-${repo}-${number}`;

      // Only update if needed
      if (activeTabId === expectedTabId) return;

      // Check if tab already exists
      const existing = getExistingPRTab(owner, repo, number);
      if (existing) {
        setActiveTab(existing.id);
      } else {
        // Create new tab
        openTab({
          id: expectedTabId,
          type: "pr-review",
          label: `#${number}`,
          owner,
          repo,
          number,
        });
      }
    } else {
      // Home route - only switch if not already on home
      if (activeTabId !== "home") {
        setActiveTab("home");
      }
    }
  }, [params.owner, params.repo, params.number]);

  // Navigate when clicking on a tab
  const handleTabSelect = useCallback(
    (tab: Tab) => {
      // Clear updated flag and record as viewed when switching to a PR tab
      if (
        tab.type === "pr-review" &&
        tab.owner &&
        tab.repo &&
        tab.number !== undefined
      ) {
        markTabUpdated(tab.id);
        setLastViewed(`${tab.owner}/${tab.repo}#${tab.number}`);
      }
      if (tab.type === "home") {
        navigate("/");
      } else if (
        tab.type === "pr-review" &&
        tab.owner &&
        tab.repo &&
        tab.number
      ) {
        navigate(`/${tab.owner}/${tab.repo}/pull/${tab.number}`);
      }
    },
    [navigate, markTabUpdated]
  );

  // Close a tab and navigate to the next active tab if needed
  const handleTabClose = useCallback(
    (tabId: string) => {
      if (tabId === activeTabId) {
        const tabIndex = tabs.findIndex((t) => t.id === tabId);
        const newTabs = tabs.filter((t) => t.id !== tabId);
        const nextTab = newTabs[Math.min(tabIndex, newTabs.length - 1)];
        closeTab(tabId);
        handleTabSelect(nextTab);
      } else {
        closeTab(tabId);
      }
    },
    [activeTabId, tabs, closeTab, handleTabSelect]
  );

  // Handle keyboard shortcuts for tab switching
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + number to switch tabs
      if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const index = parseInt(e.key) - 1;
        if (tabs[index]) {
          handleTabSelect(tabs[index]);
        }
      }
      // Cmd/Ctrl + W to close current tab
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        if (activeTabId !== "home") {
          e.preventDefault();
          handleTabClose(activeTabId);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [tabs, activeTabId, handleTabSelect, handleTabClose]);

  // Reset title when switching to home tab
  useEffect(() => {
    if (activeTabId === "home") {
      document.title = isAuthenticated ? "Home · Pulldash" : "Pulldash";
    }
  }, [activeTabId, isAuthenticated]);

  // Background detection: poll PR timestamps when tab or window is not focused
  useEffect(() => {
    const POLL_INTERVAL = 60000; // 60 seconds
    let interval: ReturnType<typeof setInterval> | null = null;

    const isInBackground = () => document.hidden || !document.hasFocus();

    const getBaseline = (
      viewerLastViewedAt: string | null,
      enrichment: PREnrichment | null
    ): string | null => {
      const dates: string[] = [];
      if (viewerLastViewedAt) dates.push(viewerLastViewedAt);
      if (enrichment?.isReadByViewer && enrichment.updatedAt)
        dates.push(enrichment.updatedAt);
      return dates.length > 0 ? dates.reduce((a, b) => (a > b ? a : b)) : null;
    };

    const checkPRs = async () => {
      const prTabs = tabs.filter(
        (t): t is Tab & { owner: string; repo: string; number: number } =>
          t.type === "pr-review" &&
          t.owner !== undefined &&
          t.repo !== undefined &&
          t.number !== undefined
      );

      const involvedPRs = await githubStore.fetchInvolvedPRs();

      // Collect all unique PRs to fetch enrichment for
      const prSet = new Map<
        string,
        { owner: string; repo: string; number: number }
      >();
      const addPr = (owner: string, repo: string, number: number) => {
        prSet.set(`${owner}/${repo}/${number}`, { owner, repo, number });
      };
      for (const tab of prTabs) addPr(tab.owner, tab.repo, tab.number);
      for (const pr of involvedPRs) {
        const match = pr.repository_url?.match(/repos\/([^/]+)\/([^/]+)/);
        if (match && pr.number) addPr(match[1], match[2], pr.number);
      }
      if (prSet.size === 0) return;

      const enrichmentMap = await githubStore.getPREnrichment([
        ...prSet.values(),
      ]);

      const tabPrIds = new Set(
        prTabs.map((t) => `${t.owner}/${t.repo}#${t.number}`)
      );

      for (const tab of prTabs) {
        const key = `${tab.owner}/${tab.repo}/${tab.number}`;
        const prId = `${tab.owner}/${tab.repo}#${tab.number}`;
        const enrichment = enrichmentMap.get(key);
        if (!enrichment) continue;
        const viewerLastViewedAt = getLastViewed(prId);
        const baseline = getBaseline(viewerLastViewedAt, enrichment);
        if (baseline && enrichment.updatedAt > baseline) {
          markTabUpdated(tab.id);
          if (
            notifsEnabled() &&
            enrichment.updatedAt > (getNotifiedAt(prId) ?? "")
          ) {
            const prUrl = `/${tab.owner}/${tab.repo}/pull/${tab.number}`;
            sendNotification(key, tab.prTitle || `#${tab.number}`, prUrl);
            setNotifiedAt(prId, enrichment.updatedAt);
          }
        }
      }

      for (const pr of involvedPRs) {
        const match = pr.repository_url?.match(/repos\/([^/]+)\/([^/]+)/);
        if (!match || !pr.number) continue;
        const owner = match[1];
        const repo = match[2];
        const number = pr.number;
        const prId = `${owner}/${repo}#${number}`;
        const prKey = `${owner}/${repo}/${number}`;
        if (tabPrIds.has(prId)) continue;

        const enrichment = enrichmentMap.get(prKey);
        if (!enrichment) continue;
        const viewerLastViewedAt = getLastViewed(prId);
        const baseline = getBaseline(viewerLastViewedAt, enrichment);
        if (
          notifsEnabled() &&
          enrichment.updatedAt > (getNotifiedAt(prId) ?? "") &&
          (!baseline || enrichment.updatedAt > baseline)
        ) {
          const prUrl = `/${owner}/${repo}/pull/${number}`;
          sendNotification(prKey, pr.title, prUrl);
          setNotifiedAt(prId, enrichment.updatedAt);
        }
      }
    };

    const startPolling = () => {
      if (!interval) {
        checkPRs();
        interval = setInterval(checkPRs, POLL_INTERVAL);
      }
    };

    const stopPolling = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (
        activeTab?.type === "pr-review" &&
        activeTab.owner &&
        activeTab.repo &&
        activeTab.number !== undefined
      ) {
        clearTabUpdated(activeTab.id);
        setLastViewed(
          `${activeTab.owner}/${activeTab.repo}#${activeTab.number}`
        );
      }
    };

    const onStateChange = () => {
      if (isInBackground()) {
        startPolling();
      } else {
        stopPolling();
      }
    };

    document.addEventListener("visibilitychange", onStateChange);
    window.addEventListener("blur", onStateChange);
    window.addEventListener("focus", onStateChange);
    return () => {
      document.removeEventListener("visibilitychange", onStateChange);
      window.removeEventListener("blur", onStateChange);
      window.removeEventListener("focus", onStateChange);
      if (interval) clearInterval(interval);
    };
  }, [tabs, activeTab, githubStore, markTabUpdated, clearTabUpdated]);

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      {/* Native-style Tab Bar */}
      <div className="h-9 bg-muted flex items-center shrink-0 border-b border-border/50">
        {/* Logo with tooltip */}
        <div className="h-full flex items-center gap-1.5 px-3 shrink-0">
          <HoverCard openDelay={200} closeDelay={100}>
            <HoverCardTrigger asChild>
              <button className="flex items-center focus:outline-none">
                <img
                  src={"/logo.svg"}
                  alt="Pulldash"
                  className="w-4 h-4 block"
                />
              </button>
            </HoverCardTrigger>
            <HoverCardContent side="bottom" align="start" className="w-64">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <img src={"/logo.svg"} alt="Pulldash" className="w-6 h-6" />
                  <div>
                    <h4 className="text-sm font-semibold">Pulldash</h4>
                    <p className="text-[10px] text-muted-foreground font-mono">
                      v{version}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  A fast, local PR review dashboard for GitHub. Review pull
                  requests with a native-like experience.
                </p>
                <a
                  href={__REPO_URL__}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                >
                  <ExternalLink className="w-3 h-3" />
                  View on GitHub
                </a>
              </div>
            </HoverCardContent>
          </HoverCard>
        </div>

        {/* Tabs */}
        <div className="h-full flex-1 flex items-center gap-0.5 overflow-x-auto hide-scrollbar">
          {tabs.map((tab) => (
            <TabItem
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              onSelect={() => handleTabSelect(tab)}
              onClose={() => handleTabClose(tab.id)}
            />
          ))}
        </div>

        {/* PR URL input & User menu */}
        <div className="h-full flex items-center gap-2 pr-2 sm:pr-3">
          <div className="hidden sm:block">
            <PRUrlInput />
          </div>
          {!isAuthenticated && (
            <a
              href={__REPO_URL__}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
              title="View on GitHub"
            >
              <Github className="w-4 h-4" />
            </a>
          )}
          <UserMenuButton />
        </div>
      </div>

      {/* Content Area - Only render active tab to avoid parallel data fetching */}
      <div className="flex-1 overflow-hidden relative">
        {/* Home is always mounted (lightweight) */}
        <div
          className={cn(
            "absolute inset-0",
            activeTabId !== "home" && "invisible pointer-events-none"
          )}
        >
          <Home />
        </div>

        {/* PR Review - only render active tab */}
        {activeTab?.type === "pr-review" &&
          activeTab.owner &&
          activeTab.repo &&
          activeTab.number && (
            <div key={activeTab.id} className="absolute inset-0">
              <PRReviewContent
                owner={activeTab.owner}
                repo={activeTab.repo}
                number={activeTab.number}
                tabId={activeTab.id}
                cachedPr={
                  activeTab.prTitle && activeTab.prAuthor
                    ? { title: activeTab.prTitle, user: activeTab.prAuthor }
                    : null
                }
              />
            </div>
          )}
      </div>
    </div>
  );
}

// ============================================================================
// Tab Item
// ============================================================================

interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
}

function TabItem({ tab, isActive, onSelect, onClose }: TabItemProps) {
  const isHome = tab.type === "home";

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose();
    },
    [onClose]
  );

  const handleMiddleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1 && !isHome) {
        e.preventDefault();
        onClose();
      }
    },
    [isHome, onClose]
  );

  const tabContent = (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onMouseDown={handleMiddleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-md transition-colors shrink-0 max-w-[180px] cursor-pointer",
        isActive
          ? "bg-background text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-white/5"
      )}
    >
      {isHome ? (
        <HomeIcon className="w-3 h-3 shrink-0" />
      ) : tab.status?.state === "merged" ? (
        <GitMerge className="w-3 h-3 shrink-0 text-purple-500" />
      ) : (
        <TabStatusIndicator status={tab.status} />
      )}

      <span className="truncate max-w-[100px]">
        {isHome ? "Home" : (tab.prTitle ?? tab.label)}
      </span>

      {/* Repo name for PR tabs */}
      {tab.type === "pr-review" && tab.repo && (
        <span className="text-[10px] text-muted-foreground truncate hidden sm:inline">
          {tab.repo}
        </span>
      )}

      {/* Close button */}
      {!isHome && (
        <button
          onClick={handleClose}
          className={cn(
            "p-0.5 rounded hover:bg-white/10 transition-opacity shrink-0",
            isActive
              ? "opacity-60 hover:opacity-100"
              : "opacity-0 group-hover:opacity-60 hover:!opacity-100"
          )}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );

  if (isHome) return tabContent;

  return (
    <HoverCard openDelay={400} closeDelay={100}>
      <HoverCardTrigger asChild>{tabContent}</HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        className="w-auto max-w-xs p-2"
      >
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] font-mono text-muted-foreground">
            #{tab.number} · {tab.owner}/{tab.repo}
          </span>
          <span className="text-xs font-medium leading-snug">
            {tab.prTitle ?? tab.label}
          </span>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

// ============================================================================
// Status Indicator
// ============================================================================

function TabStatusIndicator({ status }: { status?: TabStatus }) {
  if (!status) {
    // Loading state - show pulsing dot
    return (
      <span className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-pulse shrink-0" />
    );
  }

  // Updated while in background gets an orange dot
  if (status.updated) {
    return (
      <span
        className="w-2 h-2 rounded-full shrink-0 bg-orange-500"
        title="New activity"
      />
    );
  }

  // Queued PRs always get the merge-queue color regardless of checks/mergeability
  if (status.inMergeQueue && status.state === "open") {
    return (
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: "#9a6700" }}
        title="In merge queue"
      />
    );
  }

  // Determine the color based on state and checks
  let colorClass = "bg-muted-foreground/50"; // default/unknown
  let title = "Unknown";

  if (status.state === "closed") {
    colorClass = "bg-red-500";
    title = "Closed";
  } else if (status.state === "draft") {
    colorClass = "bg-muted-foreground";
    title = "Draft";
  } else if (status.state === "open") {
    // Open PR - color based on checks and mergeability
    if (status.mergeable === false) {
      colorClass = "bg-red-500";
      title = "Has conflicts";
    } else if (status.checks === "failure") {
      colorClass = "bg-red-500";
      title = "Checks failing";
    } else if (status.checks === "pending") {
      colorClass = "bg-yellow-500";
      title = "Checks running";
    } else if (status.checks === "success" || status.checks === "none") {
      colorClass = "bg-green-500";
      title = status.mergeable ? "Ready to merge" : "Checks passed";
    }
  }

  return (
    <span
      className={cn("w-2 h-2 rounded-full shrink-0", colorClass)}
      title={title}
    />
  );
}

// ============================================================================
// PR URL Input
// ============================================================================

function PRUrlInput() {
  const openPRReviewTab = useOpenPRReviewTab();
  const [prUrl, setPrUrl] = useState("");

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const url = prUrl.trim();
      if (!url) return;

      const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (match) {
        const [, owner, repo, number] = match;
        openPRReviewTab(owner, repo, parseInt(number, 10));
        setPrUrl("");
      }
    },
    [prUrl, openPRReviewTab]
  );

  return (
    <form onSubmit={handleSubmit} className="max-w-[180px]">
      <div className="relative">
        <input
          type="text"
          value={prUrl}
          onChange={(e) => setPrUrl(e.target.value)}
          placeholder="PR URL..."
          className="w-full h-6 pl-6 pr-2 rounded-md border border-border/50 bg-white/5 text-[11px] placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring focus:border-transparent font-mono"
        />
        <GitPullRequest className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/50" />
      </div>
    </form>
  );
}
