import React, {
  useState,
  useEffect,
  useCallback,
  memo,
  useMemo,
  useRef,
} from "react";
import {
  Loader2,
  GitPullRequest,
  GitMerge,
  ExternalLink,
  MessageSquare,
  Check,
  CheckCircle2,
  XCircle,
  MinusCircle,
  AlertCircle,
  ChevronDown,
  Clock,
  GitCommit,
  Copy,
  Settings,
  Circle,
  Eye,
  X,
  Plus,
  User,
  Tag,
  Milestone,
  Link,
  Trash2,
  Pencil,
  FileEdit,
  Files,
  Lock,
  Unlock,
  GitBranch,
  Users,
  UserPlus,
  UserMinus,
  RefreshCw,
  Reply,
} from "lucide-react";
import { Skeleton } from "../ui/skeleton";
import { Checkbox } from "../ui/checkbox";
import { cn } from "../cn";
import { Markdown, MarkdownEditor } from "../ui/markdown";
import { UserHoverCard, UserAvatar } from "../ui/user-hover-card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { EmojiReactions } from "./emoji-reactions";
import {
  usePRReviewSelector,
  usePRReviewStore,
  type OverviewTab,
} from "../contexts/pr-review";
import { getTimeAgo, formatDateTime } from "../lib/dates";
import { parseDiffCached, type ParsedDiff } from "../lib/diff";
import type { ReviewComment } from "@/api/types";
import { useQuery } from "@tanstack/react-query";
import { queries } from "../lib/queries";
import {
  useGitHub,
  useGitHubReady,
  useCurrentUser,
  type Review as GitHubReview,
  type IssueComment as GitHubIssueComment,
  type CheckRun as GitHubCheckRun,
  type CombinedStatus as GitHubCombinedStatus,
  type PRCommit,
  type Reaction,
  type ReactionContent,
  type TimelineEvent,
  type ReviewThread,
  type PullRequest,
  type PushVersion,
} from "../contexts/github";
import { useCanWrite } from "../contexts/auth";
import {
  isMetadataComment as isSingleCommentMetadata,
  stripCommitMetadataPrefix,
  parseCommitMetadataMarker,
  getCommentDisplayPath,
} from "../../shared/commit-metadata";
import { buildMetadataLines } from "../contexts/pr-review/useCurrentDiff";

// ============================================================================
// Types
// ============================================================================

type Review = GitHubReview;
type CheckRun = GitHubCheckRun;
type CombinedStatus = GitHubCombinedStatus;
type IssueComment = GitHubIssueComment;

type TabType = OverviewTab;

// ============================================================================
// Main Component
// ============================================================================

export const PROverview = memo(function PROverview() {
  const github = useGitHub();
  const store = usePRReviewStore();
  const canWrite = useCanWrite();
  const pr = usePRReviewSelector((s) => s.pr);
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const files = usePRReviewSelector((s) => s.files);
  const currentUser = useCurrentUser()?.login ?? null;

  // Read PR data from store
  const reviews = usePRReviewSelector((s) => s.reviews);
  const reviewThreads = usePRReviewSelector((s) => s.reviewThreads);
  const checks = usePRReviewSelector((s) => s.checks);
  const checksLastUpdated = usePRReviewSelector((s) => s.checksLastUpdated);
  const loadingChecks = usePRReviewSelector((s) => s.loadingChecks);
  const workflowRunsAwaitingApproval = usePRReviewSelector(
    (s) => s.workflowRunsAwaitingApproval
  );
  const approvingWorkflows = usePRReviewSelector((s) => s.approvingWorkflows);
  const timeline = usePRReviewSelector((s) => s.timeline);
  const commits = usePRReviewSelector((s) => s.commits);
  const pushVersions = usePRReviewSelector((s) => s.pushVersions);
  const commitsByVersion = usePRReviewSelector((s) => s.commitsByVersion);
  const versionDiffCounts = usePRReviewSelector((s) => s.versionDiffCounts);
  const versionRebaseInfo = usePRReviewSelector((s) => s.versionRebaseInfo);
  const conversation = usePRReviewSelector((s) => s.conversation);
  const loading = usePRReviewSelector((s) => s.loading);
  const overviewLoading = usePRReviewSelector((s) => s.overviewLoading);
  const branchDeleted = usePRReviewSelector((s) => s.branchDeleted);

  // Merge state from store
  const merging = usePRReviewSelector((s) => s.merging);
  const mergeMethod = usePRReviewSelector((s) => s.mergeMethod);
  const mergeError = usePRReviewSelector((s) => s.mergeError);
  const repoHasMergeQueue = usePRReviewSelector((s) => s.repoHasMergeQueue);
  const prInMergeQueue = usePRReviewSelector((s) => s.prInMergeQueue);
  const dequeueing = usePRReviewSelector((s) => s.dequeueing);

  // Action loading states from store
  const closingPR = usePRReviewSelector((s) => s.closingPR);
  const reopeningPR = usePRReviewSelector((s) => s.reopeningPR);
  const deletingBranch = usePRReviewSelector((s) => s.deletingBranch);
  const restoringBranch = usePRReviewSelector((s) => s.restoringBranch);
  const convertingToDraft = usePRReviewSelector((s) => s.convertingToDraft);
  const convertingToDraftError = usePRReviewSelector(
    (s) => s.convertingToDraftError
  );
  const markingReady = usePRReviewSelector((s) => s.markingReady);
  const markingReadyError = usePRReviewSelector((s) => s.markingReadyError);

  // Viewer permissions from store
  const viewerPermission = usePRReviewSelector((s) => s.viewerPermission);
  const viewerCanMergeAsAdmin = usePRReviewSelector(
    (s) => s.viewerCanMergeAsAdmin
  );

  // Active tab is driven by the URL via the store.
  const activeTab = usePRReviewSelector((s) => s.overviewActiveTab);
  const setActiveTab = useCallback(
    (tab: TabType) => {
      store.setOverviewActiveTab(tab);
    },
    [store]
  );
  // Local UI state (not in store)
  const [showMergeOptions, setShowMergeOptions] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);
  const [assigningSelf, setAssigningSelf] = useState(false);
  const [refreshingChecks, setRefreshingChecks] = useState(false);
  const overviewRef = useRef<HTMLDivElement>(null);

  // Scroll to top/bottom via gg/ge keyboard shortcuts
  useEffect(() => {
    const el = overviewRef.current;
    if (!el) return;
    const onTop = () => {
      el.scrollTop = 0;
    };
    const onBottom = () => {
      el.scrollTop = el.scrollHeight;
    };
    window.addEventListener("pr-review:scroll-to-top", onTop);
    window.addEventListener("pr-review:scroll-to-bottom", onBottom);
    return () => {
      window.removeEventListener("pr-review:scroll-to-top", onTop);
      window.removeEventListener("pr-review:scroll-to-bottom", onBottom);
    };
  }, [loading]);

  // Overview keyboard navigation state
  const [focusedOverviewItemId, setFocusedOverviewItemId] = useState<
    string | null
  >(null);
  const [replyingToOverviewItem, setReplyingToOverviewItem] = useState<
    string | null
  >(null);

  // Repo permissions - use GraphQL viewerPermission as primary source
  const isArchived = pr.base?.repo?.archived ?? false;
  // WRITE, MAINTAIN, or ADMIN permissions allow merging and resolving threads
  const hasWritePermission =
    viewerPermission === "ADMIN" ||
    viewerPermission === "MAINTAIN" ||
    viewerPermission === "WRITE";
  const canPush =
    hasWritePermission || pr.base?.repo?.permissions?.push === true;
  const canMergeRepo = canWrite && canPush && !isArchived;
  // Resolving threads requires write permission to the repo
  const canResolveThread = canWrite && hasWritePermission;

  // Reviewers and Assignees state
  const { ready } = useGitHubReady();
  const { data: collaboratorsRaw = [], isLoading: loadingCollaborators } =
    useQuery({ ...queries.collaborators(owner, repo), enabled: ready });
  const collaborators = collaboratorsRaw.map((c) => ({
    login: c.login || "",
    avatar_url: c.avatar_url || "",
  }));
  const [showReviewersPicker, setShowReviewersPicker] = useState(false);
  const [showAssigneesPicker, setShowAssigneesPicker] = useState(false);
  const [reviewersPickerPosition, setReviewersPickerPosition] = useState({
    top: 0,
    left: 0,
  });
  const [assigneesPickerPosition, setAssigneesPickerPosition] = useState({
    top: 0,
    left: 0,
  });
  const [reviewerSearchQuery, setReviewerSearchQuery] = useState("");
  const [assigneeSearchQuery, setAssigneeSearchQuery] = useState("");
  const reviewersButtonRef = useRef<HTMLButtonElement>(null);
  const assigneesButtonRef = useRef<HTMLButtonElement>(null);
  const reviewerSearchInputRef = useRef<HTMLInputElement>(null);
  const assigneeSearchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = `${pr.title} · Pull Request #${pr.number} · Pulldash`;
  }, [pr.title, pr.number]);

  // Scroll to target when overviewScrollTarget changes
  const overviewScrollTarget = usePRReviewSelector(
    (s) => s.overviewScrollTarget
  );
  useEffect(() => {
    if (!overviewScrollTarget) return;

    // Small delay to ensure the element is rendered
    const timer = setTimeout(() => {
      const element = document.getElementById(overviewScrollTarget);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "start" });
        // Flash highlight effect
        element.classList.add("ring-2", "ring-blue-500/50");
        setTimeout(() => {
          element.classList.remove("ring-2", "ring-blue-500/50");
        }, 2000);
        store.clearOverviewScrollTarget();
      } else if (!loading && !overviewLoading) {
        // Data is fully loaded but element wasn't found — give up
        store.clearOverviewScrollTarget();
      }
      // If still loading, keep the target — effect re-runs when loading finishes
    }, 100);

    return () => clearTimeout(timer);
  }, [overviewScrollTarget, store, loading, overviewLoading]);

  // Manual refresh handler
  const handleRefreshChecks = useCallback(async () => {
    setRefreshingChecks(true);
    await store.refreshChecks();
    setRefreshingChecks(false);
  }, [store]);

  const handleNavigateChecks = useCallback(
    async (sha: string) => {
      await store.setSelectedHeadSha(sha);
      setActiveTab("checks");
    },
    [store]
  );

  const handleNavigateCommit = useCallback(
    async (sha: string, versionSha?: string) => {
      if (versionSha) {
        await store.setSelectedHeadSha(versionSha);
      }
      await store.setSelectedCommitSha(sha);
      const { files } = store.getSnapshot();
      if (files.length > 0) {
        store.selectFile(files[0].filename);
      }
    },
    [store]
  );

  const checkStatus = calculateCheckStatus(
    checks,
    workflowRunsAwaitingApproval
  );

  // Auto-refresh checks — poll faster while workflows are still running
  useEffect(() => {
    if (pr.state !== "open" || pr.merged) return;

    const interval = setInterval(
      () => {
        store.refreshChecks();
      },
      checkStatus === "pending" ? 10_000 : 30_000
    );

    return () => clearInterval(interval);
  }, [store, pr.state, pr.merged, checkStatus]);

  const handleMerge = useCallback(async () => {
    await store.mergePR();
  }, [store]);

  const handleDequeue = useCallback(async () => {
    await store.dequeuePR();
  }, [store]);

  const handleApproveWorkflows = useCallback(async () => {
    await store.approveWorkflows();
  }, [store]);

  const handleAddComment = useCallback(async () => {
    if (!commentText.trim()) return;

    setSubmittingComment(true);
    try {
      const newComment = await github.createPRConversationComment(
        owner,
        repo,
        pr.number,
        commentText
      );
      store.addConversationComment(newComment);
      store.addTimelineEvent({
        event: "commented",
        id: newComment.id,
        node_id: newComment.node_id,
        url: newComment.url,
        body: newComment.body,
        body_html: newComment.body_html,
        html_url: newComment.html_url,
        user: newComment.user!,
        created_at: newComment.created_at,
        updated_at: newComment.updated_at,
        issue_url: newComment.issue_url,
        author_association: newComment.author_association,
        actor: newComment.user!,
      } as TimelineEvent);
      setCommentText("");
    } catch (error) {
      console.error("Failed to add comment:", error);
    } finally {
      setSubmittingComment(false);
    }
  }, [github, owner, repo, pr.number, commentText, store]);

  const handleCommentKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleAddComment();
      }
    },
    [handleAddComment]
  );

  const handleUpdateBranch = useCallback(async () => {
    await store.updateBranch();
  }, [store]);

  const handleToggleReviewersPicker = useCallback(() => {
    if (!showReviewersPicker && reviewersButtonRef.current) {
      const rect = reviewersButtonRef.current.getBoundingClientRect();
      setReviewersPickerPosition({
        top: rect.bottom + 4,
        left: Math.min(rect.left, window.innerWidth - 280),
      });
      setReviewerSearchQuery("");
      // Focus the search input after a short delay to allow the picker to render
      setTimeout(() => reviewerSearchInputRef.current?.focus(), 50);
    }
    setShowReviewersPicker(!showReviewersPicker);
    setShowAssigneesPicker(false);
  }, [showReviewersPicker]);

  const handleToggleAssigneesPicker = useCallback(() => {
    if (!showAssigneesPicker && assigneesButtonRef.current) {
      const rect = assigneesButtonRef.current.getBoundingClientRect();
      setAssigneesPickerPosition({
        top: rect.bottom + 4,
        left: Math.min(rect.left, window.innerWidth - 280),
      });
      setAssigneeSearchQuery("");
      // Focus the search input after a short delay to allow the picker to render
      setTimeout(() => assigneeSearchInputRef.current?.focus(), 50);
    }
    setShowAssigneesPicker(!showAssigneesPicker);
    setShowReviewersPicker(false);
  }, [showAssigneesPicker]);

  // Helper to refetch PR and update store
  const refetchPR = useCallback(async () => {
    try {
      const updatedPR = await github.getPR(owner, repo, pr.number);
      store.setPr(updatedPR);
    } catch (error) {
      console.error("Failed to refetch PR:", error);
    }
  }, [github, owner, repo, pr.number, store]);

  const handleConvertToDraft = useCallback(async () => {
    await store.convertToDraft();
  }, [store]);

  const handleMarkReadyForReview = useCallback(async () => {
    await store.markReadyForReview();
  }, [store]);

  const handleClosePR = useCallback(async () => {
    // Post comment first if there's one typed (like GitHub does)
    if (commentText.trim()) {
      try {
        const newComment = await github.createPRConversationComment(
          owner,
          repo,
          pr.number,
          commentText
        );
        store.addConversationComment(newComment);
        setCommentText("");
      } catch (error) {
        console.error("Failed to add comment:", error);
      }
    }
    await store.closePR();
  }, [github, owner, repo, pr.number, commentText, store]);

  const handleReopenPR = useCallback(async () => {
    // Post comment first if there's one typed (like GitHub does)
    if (commentText.trim()) {
      try {
        const newComment = await github.createPRConversationComment(
          owner,
          repo,
          pr.number,
          commentText
        );
        store.addConversationComment(newComment);
        setCommentText("");
      } catch (error) {
        console.error("Failed to add comment:", error);
      }
    }
    await store.reopenPR();
  }, [github, owner, repo, pr.number, commentText, store]);

  const handleDeleteBranch = useCallback(async () => {
    if (
      !window.confirm(
        `Are you sure you want to delete the branch "${pr.head.ref}"?`
      )
    ) {
      return;
    }
    await store.deleteBranch();
  }, [store, pr.head.ref]);

  const handleRestoreBranch = useCallback(async () => {
    await store.restoreBranch();
  }, [store]);

  // Helper to refetch timeline after mutations
  const refetchTimeline = useCallback(() => {
    github
      .getPRTimeline(owner, repo, pr.number)
      .then((timeline) => store.setTimeline(timeline))
      .catch(() => {});
  }, [github, owner, repo, pr.number, store]);

  const handleRequestReviewer = useCallback(
    async (login: string) => {
      // Find the collaborator to get avatar_url
      const collaborator = collaborators.find((c) => c.login === login);
      try {
        // 1. Request GitHub to add reviewer
        await github.requestReviewers(owner, repo, pr.number, [login]);

        // 2. Update our state with the known change
        const newReviewer = {
          login,
          avatar_url: collaborator?.avatar_url ?? "",
          id: 0,
          node_id: "",
          gravatar_id: "",
          url: "",
          html_url: "",
          followers_url: "",
          following_url: "",
          gists_url: "",
          starred_url: "",
          subscriptions_url: "",
          organizations_url: "",
          repos_url: "",
          events_url: "",
          received_events_url: "",
          type: "User" as const,
          site_admin: false,
          user_view_type: "public" as const,
        };
        store.setPr({
          ...pr,
          requested_reviewers: [...(pr.requested_reviewers ?? []), newReviewer],
        });

        // 3. Invalidate cache so future fetches get fresh data
        github.invalidatePR(owner, repo, pr.number);

        // 4. Refetch timeline (reviewer request creates event)
        refetchTimeline();
      } catch (error) {
        console.error("Failed to request reviewer:", error);
      }
    },
    [github, owner, repo, pr, store, collaborators, refetchTimeline]
  );

  const handleRemoveReviewer = useCallback(
    async (login: string) => {
      try {
        // 1. Request GitHub to remove reviewer
        await github.removeReviewers(owner, repo, pr.number, [login]);

        // 2. Update our state with the known change
        store.setPr({
          ...pr,
          requested_reviewers: (pr.requested_reviewers ?? []).filter(
            (r) => r.login !== login
          ),
        });

        // 3. Invalidate cache so future fetches get fresh data
        github.invalidatePR(owner, repo, pr.number);

        // 4. Refetch timeline
        refetchTimeline();
      } catch (error) {
        console.error("Failed to remove reviewer:", error);
      }
    },
    [github, owner, repo, pr, store, refetchTimeline]
  );

  const handleAddAssignee = useCallback(
    async (login: string) => {
      // Find the collaborator to get avatar_url
      const collaborator = collaborators.find((c) => c.login === login);
      try {
        // 1. Request GitHub to add assignee
        await github.addAssignees(owner, repo, pr.number, [login]);

        // 2. Update our state with the known change
        const newAssignee = {
          login,
          avatar_url: collaborator?.avatar_url ?? "",
          id: 0,
          node_id: "",
          gravatar_id: "",
          url: "",
          html_url: "",
          followers_url: "",
          following_url: "",
          gists_url: "",
          starred_url: "",
          subscriptions_url: "",
          organizations_url: "",
          repos_url: "",
          events_url: "",
          received_events_url: "",
          type: "User" as const,
          site_admin: false,
          user_view_type: "public" as const,
        };
        store.setPr({
          ...pr,
          assignees: [...(pr.assignees ?? []), newAssignee],
        });

        // 3. Invalidate cache so future fetches get fresh data
        github.invalidatePR(owner, repo, pr.number);

        // 4. Refetch timeline (assignee change creates event)
        refetchTimeline();
      } catch (error) {
        console.error("Failed to add assignee:", error);
      }
    },
    [github, owner, repo, pr, store, collaborators, refetchTimeline]
  );

  const handleRemoveAssignee = useCallback(
    async (login: string) => {
      try {
        // 1. Request GitHub to remove assignee
        await github.removeAssignees(owner, repo, pr.number, [login]);

        // 2. Update our state with the known change
        store.setPr({
          ...pr,
          assignees: (pr.assignees ?? []).filter((a) => a.login !== login),
        });

        // 3. Invalidate cache so future fetches get fresh data
        github.invalidatePR(owner, repo, pr.number);

        // 4. Refetch timeline
        refetchTimeline();
      } catch (error) {
        console.error("Failed to remove assignee:", error);
      }
    },
    [github, owner, repo, pr, store, refetchTimeline]
  );

  const handleAssignSelf = useCallback(async () => {
    if (!currentUser) return;

    setAssigningSelf(true);
    try {
      // 1. Request GitHub to add assignee
      await github.addAssignees(owner, repo, pr.number, [currentUser]);

      // 2. Update our state with the known change
      const newAssignee = {
        login: currentUser,
        avatar_url: "",
        id: 0,
        node_id: "",
        gravatar_id: "",
        url: "",
        html_url: "",
        followers_url: "",
        following_url: "",
        gists_url: "",
        starred_url: "",
        subscriptions_url: "",
        organizations_url: "",
        repos_url: "",
        events_url: "",
        received_events_url: "",
        type: "User" as const,
        site_admin: false,
        user_view_type: "public" as const,
      };
      store.setPr({
        ...pr,
        assignees: [...(pr.assignees ?? []), newAssignee],
      });

      // 3. Invalidate cache so future fetches get fresh data
      github.invalidatePR(owner, repo, pr.number);

      // 4. Refetch timeline
      refetchTimeline();
    } catch (error) {
      console.error("Failed to assign self:", error);
    } finally {
      setAssigningSelf(false);
    }
  }, [github, owner, repo, pr, currentUser, store, refetchTimeline]);

  // Reaction state - keyed by "issue" for PR body or comment ID
  const [reactions, setReactions] = useState<Record<string, Reaction[]>>({});
  const [loadingReactions, setLoadingReactions] = useState<Set<string>>(
    new Set()
  );

  // Fetch PR body reactions
  useEffect(() => {
    const fetchPRReactions = async () => {
      try {
        const prReactions = await github.getIssueReactions(
          owner,
          repo,
          pr.number
        );
        setReactions((prev) => ({ ...prev, issue: prReactions }));
      } catch (error) {
        console.error("Failed to fetch PR reactions:", error);
      }
    };
    fetchPRReactions();
  }, [github, owner, repo, pr.number]);

  // Helper: retry an async function up to `retries` times with 1s backoff
  async function withRetry<T>(
    fn: () => Promise<T>,
    retries = 2
  ): Promise<T | null> {
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i < retries) await new Promise((r) => setTimeout(r, 1000));
        else {
          console.error("Failed to fetch reactions after retries:", err);
          return null;
        }
      }
    }
    return null;
  }

  // Fetch comment reactions when conversation loads (batched + parallel)
  useEffect(() => {
    if (conversation.length === 0) return;

    const BATCH_SIZE = 5;

    async function fetchCommentReactions() {
      for (let i = 0; i < conversation.length; i += BATCH_SIZE) {
        const batch = conversation.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (comment) => {
            const data = await withRetry(() =>
              github.getCommentReactions(owner, repo, comment.id)
            );
            if (data) {
              return { key: `comment-${comment.id}`, data };
            }
            return null;
          })
        );
        setReactions((prev) => {
          const next = { ...prev };
          for (const r of results) {
            if (r) next[r.key] = r.data;
          }
          return next;
        });
      }
    }

    fetchCommentReactions();
  }, [github, owner, repo, conversation]);

  // Fetch review comment reactions (batched + parallel)
  useEffect(() => {
    const comments: Array<{ id: number }> = [];
    const seen = new Set<number>();
    for (const thread of reviewThreads) {
      for (const c of thread.comments.nodes) {
        if (!seen.has(c.databaseId)) {
          seen.add(c.databaseId);
          comments.push({ id: c.databaseId });
        }
      }
    }
    if (comments.length === 0) return;

    const BATCH_SIZE = 5;

    async function fetchReviewCommentReactions() {
      for (let i = 0; i < comments.length; i += BATCH_SIZE) {
        const batch = comments.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async (c) => {
            const data = await withRetry(() =>
              github.getReviewCommentReactions(owner, repo, c.id)
            );
            if (data) {
              return { key: `review-comment-${c.id}`, data };
            }
            return null;
          })
        );
        setReactions((prev) => {
          const next = { ...prev };
          for (const r of results) {
            if (r) next[r.key] = r.data;
          }
          return next;
        });
      }
    }

    fetchReviewCommentReactions();
  }, [github, owner, repo, reviewThreads]);

  const handleAddPRReaction = useCallback(
    async (content: ReactionContent) => {
      try {
        const newReaction = await github.addIssueReaction(
          owner,
          repo,
          pr.number,
          content
        );
        setReactions((prev) => ({
          ...prev,
          issue: [...(prev.issue || []), newReaction],
        }));
      } catch (error) {
        console.error("Failed to add reaction:", error);
      }
    },
    [github, owner, repo, pr.number]
  );

  const handleRemovePRReaction = useCallback(
    async (reactionId: number) => {
      try {
        await github.deleteIssueReaction(owner, repo, pr.number, reactionId);
        setReactions((prev) => ({
          ...prev,
          issue: (prev.issue || []).filter((r) => r.id !== reactionId),
        }));
      } catch (error) {
        console.error("Failed to remove reaction:", error);
      }
    },
    [github, owner, repo, pr.number]
  );

  const handleAddCommentReaction = useCallback(
    async (commentId: number, content: ReactionContent) => {
      try {
        const newReaction = await github.addCommentReaction(
          owner,
          repo,
          commentId,
          content
        );
        setReactions((prev) => ({
          ...prev,
          [`comment-${commentId}`]: [
            ...(prev[`comment-${commentId}`] || []),
            newReaction,
          ],
        }));
      } catch (error) {
        console.error("Failed to add reaction:", error);
      }
    },
    [github, owner, repo]
  );

  const handleRemoveCommentReaction = useCallback(
    async (commentId: number, reactionId: number) => {
      try {
        await github.deleteCommentReaction(owner, repo, commentId, reactionId);
        setReactions((prev) => ({
          ...prev,
          [`comment-${commentId}`]: (prev[`comment-${commentId}`] || []).filter(
            (r) => r.id !== reactionId
          ),
        }));
      } catch (error) {
        console.error("Failed to remove reaction:", error);
      }
    },
    [github, owner, repo]
  );

  // Review comment reactions (different from issue comments)
  const handleAddReviewCommentReaction = useCallback(
    async (commentId: number, content: ReactionContent) => {
      try {
        const newReaction = await github.addReviewCommentReaction(
          owner,
          repo,
          commentId,
          content
        );
        setReactions((prev) => ({
          ...prev,
          [`review-comment-${commentId}`]: [
            ...(prev[`review-comment-${commentId}`] || []),
            newReaction,
          ],
        }));
      } catch (error) {
        console.error("Failed to add review comment reaction:", error);
      }
    },
    [github, owner, repo]
  );

  const handleRemoveReviewCommentReaction = useCallback(
    async (commentId: number, reactionId: number) => {
      try {
        await github.deleteReviewCommentReaction(
          owner,
          repo,
          commentId,
          reactionId
        );
        setReactions((prev) => ({
          ...prev,
          [`review-comment-${commentId}`]: (
            prev[`review-comment-${commentId}`] || []
          ).filter((r) => r.id !== reactionId),
        }));
      } catch (error) {
        console.error("Failed to remove review comment reaction:", error);
      }
    },
    [github, owner, repo]
  );

  // Thread actions (reply, resolve, unresolve)
  const handleReplyToThread = useCallback(
    async (threadId: string, commentId: number, body: string) => {
      try {
        await github.createPRComment(owner, repo, pr.number, body, {
          reply_to_id: commentId,
        });
        // Refresh threads to show new comment
        const result = await github.getReviewThreads(owner, repo, pr.number);
        store.setReviewThreads(result.threads);
        // Refresh timeline in background (reply may create a timeline event)
        github
          .getPRTimeline(owner, repo, pr.number)
          .then((timeline) => store.setTimeline(timeline))
          .catch(() => {});
      } catch (error) {
        console.error("Failed to reply to thread:", error);
      }
    },
    [github, owner, repo, pr.number, store]
  );

  const handleQuoteConversationComment = useCallback((body: string) => {
    const commentBoxEl = document.getElementById("conversation-comment-box");
    const quoted =
      body
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n") + "\n\n";
    setCommentText(quoted);
    commentBoxEl?.scrollIntoView({ behavior: "smooth" });
    setTimeout(() => commentBoxEl?.querySelector("textarea")?.focus(), 100);
  }, []);

  const handleResolveThread = useCallback(
    async (threadId: string) => {
      try {
        await github.resolveThread(threadId);
        // Update local state
        store.updateReviewThread(threadId, (t) => ({ ...t, isResolved: true }));
      } catch (error) {
        console.error("Failed to resolve thread:", error);
      }
    },
    [github, store]
  );

  const handleUnresolveThread = useCallback(
    async (threadId: string) => {
      try {
        await github.unresolveThread(threadId);
        // Update local state
        store.updateReviewThread(threadId, (t) => ({
          ...t,
          isResolved: false,
        }));
      } catch (error) {
        console.error("Failed to unresolve thread:", error);
      }
    },
    [github, store]
  );

  const refreshConversation = useCallback(async () => {
    const [newComments, newTimeline] = await Promise.all([
      github.getPRComments(owner, repo, pr.number).catch(() => []),
      github.getPRTimeline(owner, repo, pr.number).catch(() => []),
    ]);
    store.setComments(newComments as ReviewComment[]);
    store.setTimeline(newTimeline);
  }, [github, owner, repo, pr.number, store]);

  const handleEditComment = useCallback(
    async (commentId: number, body: string) => {
      await github.updateIssueComment(owner, repo, commentId, body);
      await refreshConversation();
    },
    [github, owner, repo, refreshConversation]
  );

  const handleDeleteComment = useCallback(
    async (commentId: number) => {
      await github.deleteIssueComment(owner, repo, commentId);
      await refreshConversation();
    },
    [github, owner, repo, refreshConversation]
  );

  const handleEditReviewComment = useCallback(
    async (commentId: number, body: string) => {
      await github.updateComment(owner, repo, commentId, body);
      // Refresh threads to show updated comment
      const result = await github.getReviewThreads(owner, repo, pr.number);
      store.setReviewThreads(result.threads);
    },
    [github, owner, repo, pr.number, store]
  );

  const handleDeleteReviewComment = useCallback(
    async (commentId: number) => {
      await github.deleteComment(owner, repo, commentId);
      const result = await github.getReviewThreads(owner, repo, pr.number);
      store.setReviewThreads(result.threads);
    },
    [github, owner, repo, pr.number, store]
  );

  const latestReviews = getLatestReviewsByUser(reviews);
  const canMergePR = canMerge(pr, checkStatus);

  // Combined list of all reviewers sorted by state priority:
  // CHANGES_REQUESTED > APPROVED > COMMENTED > pending
  const allReviewers = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{
      login: string;
      avatar_url: string;
      state: Review["state"] | "PENDING";
      isTeam?: boolean;
    }> = [];

    const byUser = new Map<string, Review>();
    const requestedLogins = new Set(
      pr.requested_reviewers?.map((r) => r.login) ?? []
    );
    for (const r of reviews) {
      if (
        r.user &&
        (r.state === "APPROVED" ||
          r.state === "CHANGES_REQUESTED" ||
          r.state === "COMMENTED")
      ) {
        // Skip re-requested reviewers — they'll show as PENDING instead
        if (requestedLogins.has(r.user.login)) continue;
        byUser.set(r.user.login, r);
      }
    }

    const addReviewer = (
      login: string,
      avatar_url: string,
      state: Review["state"] | "PENDING",
      isTeam?: boolean
    ) => {
      if (seen.has(login)) return;
      seen.add(login);
      result.push({ login, avatar_url, state, isTeam });
    };

    // Priority order function
    const priority = (s: string) =>
      s === "CHANGES_REQUESTED"
        ? 0
        : s === "APPROVED"
          ? 1
          : s === "COMMENTED"
            ? 2
            : 3;

    // Collect all reviews first (changes requested, approved, commented)
    for (const r of byUser.values()) {
      if (r.user) {
        addReviewer(r.user.login, r.user.avatar_url, r.state);
      }
    }
    // Then pending reviewers who haven't submitted any review
    if (pr.requested_reviewers) {
      for (const reviewer of pr.requested_reviewers) {
        addReviewer(reviewer.login, reviewer.avatar_url, "PENDING");
      }
    }
    // Then pending team review requests
    if (pr.requested_teams) {
      for (const team of pr.requested_teams) {
        addReviewer(team.slug, "", "PENDING", true);
      }
    }

    result.sort((a, b) => priority(a.state) - priority(b.state));
    return result;
  }, [reviews, pr.requested_reviewers, pr.requested_teams]);

  // Tab counts
  const checksCount = checks
    ? checks.checkRuns.length + checks.status.statuses.length
    : 0;

  // Get unique participants
  const participants = useMemo(() => {
    const users = new Map<string, { login: string; avatar_url: string }>();

    // PR author
    if (pr.user) {
      users.set(pr.user.login, {
        login: pr.user.login,
        avatar_url: pr.user.avatar_url,
      });
    }

    // Reviewers
    reviews.forEach((review) => {
      if (review.user) {
        users.set(review.user.login, {
          login: review.user.login,
          avatar_url: review.user.avatar_url,
        });
      }
    });

    // Commenters
    conversation.forEach((comment) => {
      if (comment.user) {
        users.set(comment.user.login, {
          login: comment.user.login,
          avatar_url: comment.user.avatar_url,
        });
      }
    });

    return Array.from(users.values());
  }, [pr.user, reviews, conversation]);

  // Build list of navigable items for keyboard navigation
  const navigableItems = useMemo(() => {
    const items: string[] = [];

    // PR description is always first
    items.push("pr-description");

    // Build items from timeline (matching the render order)
    const threadsByReviewId = new Map<number, ReviewThread[]>();
    const orphanedThreads: ReviewThread[] = [];
    reviewThreads.forEach((thread) => {
      const reviewId = thread.pullRequestReview?.databaseId;
      if (reviewId) {
        const existing = threadsByReviewId.get(reviewId) || [];
        existing.push(thread);
        threadsByReviewId.set(reviewId, existing);
      } else {
        orphanedThreads.push(thread);
      }
    });

    const commentsById = new Map(conversation.map((c) => [c.id, c]));
    const reviewsById = new Map(reviews.map((r) => [r.id, r]));
    const usedReviewIds = new Set<number>();

    timeline.forEach((event) => {
      // Skip commits for navigation
      if ("sha" in event && "author" in event) return;
      if (!("event" in event)) return;
      const eventType = event.event;

      if (eventType === "closed" && pr.merged) return;

      if (eventType === "commented" && "id" in event) {
        const comment = commentsById.get(event.id as unknown as number);
        if (comment) {
          items.push(`issuecomment-${comment.id}`);
        }
        return;
      }

      if (eventType === "reviewed" && "id" in event) {
        const review = reviewsById.get(event.id as unknown as number);
        if (review) {
          const threads = threadsByReviewId.get(review.id) || [];
          const hasThreads = threads.length > 0;
          if (
            review.body ||
            review.state === "APPROVED" ||
            review.state === "CHANGES_REQUESTED" ||
            hasThreads
          ) {
            items.push(`pullrequestreview-${review.id}`);
            usedReviewIds.add(review.id);
            // Add threads under this review
            threads.forEach((t) => {
              items.push(`reviewthread-${t.id}`);
            });
          }
        }
        return;
      }
    });

    // Add orphaned threads
    orphanedThreads.forEach((thread) => {
      if (thread.comments.nodes[0]) {
        items.push(`reviewthread-${thread.id}`);
      }
    });

    return items;
  }, [timeline, conversation, reviews, reviewThreads, pr.merged]);

  // Keyboard navigation for overview
  useEffect(() => {
    if (activeTab !== "conversation") return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      // Allow Ctrl/Cmd shortcuts to pass through
      if (e.ctrlKey || e.metaKey) return;

      const currentIndex = focusedOverviewItemId
        ? navigableItems.indexOf(focusedOverviewItemId)
        : -1;

      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        const nextIndex =
          currentIndex < navigableItems.length - 1 ? currentIndex + 1 : 0;
        const nextId = navigableItems[nextIndex];
        setFocusedOverviewItemId(nextId);
        // Scroll into view
        const el = document.getElementById(nextId);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        return;
      }

      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        const prevIndex =
          currentIndex > 0 ? currentIndex - 1 : navigableItems.length - 1;
        const prevId = navigableItems[prevIndex];
        setFocusedOverviewItemId(prevId);
        const el = document.getElementById(prevId);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        setFocusedOverviewItemId(null);
        setReplyingToOverviewItem(null);
        return;
      }

      // 'r' to reply to focused item
      if (e.key === "r" && focusedOverviewItemId) {
        const id = focusedOverviewItemId;
        if (id.startsWith("issuecomment-") || id.startsWith("reviewthread-")) {
          e.preventDefault();
          setReplyingToOverviewItem(focusedOverviewItemId);
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab, focusedOverviewItemId, navigableItems]);

  if (loading) {
    return <PROverviewSkeleton />;
  }

  return (
    <div
      ref={overviewRef}
      className="flex-1 overflow-auto themed-scrollbar bg-background"
    >
      {/* Tabs */}
      <div className="border-b border-border overflow-x-auto">
        <div className="max-w-[1280px] mx-auto px-2 sm:px-6">
          <div className="flex items-center gap-1 py-1">
            <TabButton
              active={activeTab === "conversation"}
              onClick={() => setActiveTab("conversation")}
              icon={<MessageSquare className="w-4 h-4" />}
              label="Conversation"
              count={conversation.length}
            />
            <TabButton
              active={activeTab === "commits"}
              onClick={() => setActiveTab("commits")}
              icon={<GitCommit className="w-4 h-4" />}
              label="Commits"
              count={commits.length}
            />
            <TabButton
              active={activeTab === "checks"}
              onClick={() => setActiveTab("checks")}
              icon={<CheckStatusIcon status={checkStatus} size="sm" />}
              label="Checks"
              count={checksCount}
            />
            <TabButton
              active={false}
              onClick={() => {
                // Navigate to the first file
                if (files.length > 0) {
                  store.selectFile(files[0].filename);
                }
              }}
              icon={<Files className="w-4 h-4" />}
              label="Files Changed"
              count={files.length}
            />
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-[1280px] mx-auto px-3 sm:px-6 py-4 sm:py-6">
        <div className="flex flex-col md:flex-row gap-4 md:gap-6">
          {/* Left Column - Main Content */}
          <div className="flex-1 min-w-0 space-y-4 order-2 md:order-1">
            {activeTab === "conversation" && (
              <>
                {/* PR Description */}
                <CommentBox
                  id="pr-description"
                  user={pr.user}
                  createdAt={pr.created_at}
                  commentUrl={pr.html_url}
                  body={pr.body}
                  bodyHtml={pr.body_html}
                  isAuthor
                  reactions={reactions.issue}
                  onAddReaction={canWrite ? handleAddPRReaction : undefined}
                  onRemoveReaction={
                    canWrite ? handleRemovePRReaction : undefined
                  }
                  currentUser={currentUser}
                  isFocused={focusedOverviewItemId === "pr-description"}
                />

                {/* Timeline - merge comments, reviews, and events by date */}
                <div className="relative space-y-6">
                  {/* Vertical timeline line - z-0 so content appears above it */}
                  <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-muted-foreground/30 -translate-x-1/2 z-0" />

                  {(() => {
                    // Build unified timeline using GitHub's timeline order as source of truth
                    // Commits are grouped together like GitHub does
                    type CommittedEvent = Extract<
                      TimelineEvent,
                      { sha: string; author: { date: string } }
                    >;
                    type TimelineEntry =
                      | { type: "comment"; data: IssueComment }
                      | {
                          type: "review";
                          data: Review;
                          threads: ReviewThread[];
                        }
                      | { type: "event"; data: TimelineEvent }
                      | { type: "thread"; data: ReviewThread }
                      | { type: "commits"; data: CommittedEvent[] }
                      | {
                          type: "version_event";
                          event: TimelineEvent;
                          commits: PRCommit[];
                        };

                    /** Extract a reliable timestamp from a TimelineEntry, or
                     *  null if none is available. Uses GitHub API timestamps
                     *  (created_at / submitted_at / createdAt) rather than
                     *  commit author dates, which are unreliable after rebase. */
                    function entryTimestamp(e: TimelineEntry): number | null {
                      if (e.type === "review") {
                        const t = e.data.submitted_at;
                        return t ? new Date(t).getTime() : null;
                      }
                      if (e.type === "version_event") {
                        const t = (e.event as { created_at?: string })
                          .created_at;
                        return t ? new Date(t).getTime() : null;
                      }
                      if (e.type === "comment" || e.type === "event") {
                        const t = (e.data as { created_at?: string })
                          .created_at;
                        return t ? new Date(t).getTime() : null;
                      }
                      if (e.type === "thread") {
                        const t = e.data.comments.nodes[0]?.createdAt;
                        return t ? new Date(t).getTime() : null;
                      }
                      return null;
                    }

                    const entries: TimelineEntry[] = [];

                    // Build lookup maps for enriched data
                    const threadsByReviewId = new Map<number, ReviewThread[]>();
                    const orphanedThreads: ReviewThread[] = [];
                    reviewThreads.forEach((thread) => {
                      const reviewId = thread.pullRequestReview?.databaseId;
                      if (reviewId) {
                        const existing = threadsByReviewId.get(reviewId) || [];
                        existing.push(thread);
                        threadsByReviewId.set(reviewId, existing);
                      } else {
                        orphanedThreads.push(thread);
                      }
                    });

                    const commentsById = new Map(
                      conversation.map((c) => [c.id, c])
                    );
                    const reviewsById = new Map(reviews.map((r) => [r.id, r]));
                    const usedReviewIds = new Set<number>();

                    // Add PR creation as the first timeline event (version v1)
                    if (pushVersions?.[0]?.version === 1) {
                      const v1Commits =
                        commitsByVersion?.find((v) => v.version === 1)
                          ?.commits ?? [];
                      entries.push({
                        type: "version_event",
                        event: {
                          id: -1,
                          event: "opened",
                          actor: pr.user,
                          created_at: pr.created_at,
                          commit_id: pushVersions[0]?.sha,
                        } as TimelineEvent,
                        commits: v1Commits,
                      });
                    }

                    // Collect consecutive commits and associate them with
                    // the next version transition event (force-push or push)
                    let pendingCommits: CommittedEvent[] = [];
                    let lastFlushedCommits: CommittedEvent[] = [];
                    const flushCommits = () => {
                      lastFlushedCommits = pendingCommits;
                      pendingCommits = [];
                    };

                    // Process timeline in GitHub's order
                    timeline.forEach((event) => {
                      // timeline-committed-event (has sha + author)
                      if ("sha" in event && "author" in event) {
                        pendingCommits.push(event);
                        return;
                      }

                      // Flush any pending commits before adding other events
                      flushCommits();

                      if (!("event" in event)) return;
                      const eventType = event.event;

                      // Skip closed event when PR was merged (redundant with merge)
                      if (eventType === "closed" && pr.merged) return;

                      // Handle "commented" - look up enriched comment data
                      if (eventType === "commented" && "id" in event) {
                        const comment = commentsById.get(
                          event.id as unknown as number
                        );
                        if (comment) {
                          entries.push({ type: "comment", data: comment });
                        }
                        return;
                      }

                      // Handle "reviewed" - look up enriched review data with threads
                      if (eventType === "reviewed" && "id" in event) {
                        const review = reviewsById.get(
                          event.id as unknown as number
                        );
                        if (review) {
                          const hasThreads =
                            (threadsByReviewId.get(review.id)?.length ?? 0) > 0;
                          // Show APPROVED/CHANGES_REQUESTED always, COMMENTED only if they have a body OR threads
                          if (
                            review.body ||
                            review.state === "APPROVED" ||
                            review.state === "CHANGES_REQUESTED" ||
                            hasThreads
                          ) {
                            entries.push({
                              type: "review",
                              data: review,
                              threads: threadsByReviewId.get(review.id) || [],
                            });
                            usedReviewIds.add(review.id);
                          }
                        }
                        return;
                      }

                      // Skip line-commented (shown inline in reviews)
                      if (eventType === "line-commented") return;

                      // All other events — associate full commit list with
                      // force-push events (force pushes rewrite history so
                      // SHA-based diff against the previous version is misleading)
                      if (eventType === "head_ref_force_pushed") {
                        const fpEvent = event as { commit_id?: string };
                        const toVer = fpEvent.commit_id
                          ? pushVersions?.find(
                              (v) => v.sha === fpEvent.commit_id
                            )
                          : undefined;
                        const fullCommits: PRCommit[] | undefined =
                          toVer &&
                          commitsByVersion?.find(
                            (v) => v.version === toVer.version
                          )?.commits;
                        entries.push({
                          type: "version_event",
                          event: event as TimelineEvent,
                          commits: fullCommits ?? [],
                        });
                      } else {
                        entries.push({ type: "event", data: event });
                      }
                    });

                    // Flush any remaining commits
                    flushCommits();

                    // Add synthetic version transition events for normal pushes
                    // that don't have a corresponding head_ref_force_pushed event.
                    // Show the new (added) commits for each version transition.
                    // Insert them by matching their commit SHAs against the
                    // consecutive CommitGroup entries already in the timeline,
                    // so synthetic entries land at the correct position relative
                    // to GitHub's own event ordering.
                    if (pushVersions && pushVersions.length > 1) {
                      const forcePushedShas = new Set<string>();
                      for (const event of timeline) {
                        if (
                          "event" in event &&
                          event.event === "head_ref_force_pushed"
                        ) {
                          const fp = event as { commit_id?: string };
                          if (fp.commit_id) {
                            forcePushedShas.add(fp.commit_id);
                          }
                        }
                      }

                      for (let i = 1; i < pushVersions.length; i++) {
                        const toVersion = pushVersions[i];
                        const fromVersion = pushVersions[i - 1];
                        if (
                          toVersion &&
                          fromVersion &&
                          !forcePushedShas.has(toVersion.sha)
                        ) {
                          // Compute the new commits in this version by diffing
                          // the version's commit list against the previous version
                          const currCommits =
                            commitsByVersion?.find(
                              (v) => v.version === toVersion.version
                            )?.commits ?? [];
                          const prevCommits =
                            commitsByVersion?.find(
                              (v) => v.version === fromVersion.version
                            )?.commits ?? [];
                          const prevShas = new Set(
                            prevCommits.map((c) => c.sha)
                          );
                          const newCommits = currCommits.filter(
                            (c) => !prevShas.has(c.sha)
                          );

                          const synEntry: TimelineEntry = {
                            type: "version_event",
                            event: {
                              id: -i,
                              event: "head_ref_normal_pushed",
                              actor: pr.user,
                              created_at: toVersion.pushedAt,
                              commit_id: toVersion.sha,
                              from_sha: fromVersion.sha,
                              from_version: fromVersion.version,
                              to_version: toVersion.version,
                            } as TimelineEvent & {
                              from_sha?: string;
                              from_version?: number;
                              to_version?: number;
                            },
                            commits: newCommits,
                          };

                          // Find the matching version_event by SHA, then walk
                          // forward. Insert before the next version_event, or
                          // before the first entry whose created_at timestamp
                          // is after toVersion.pushedAt. This puts the
                          // synthetic entry after all entries that belong to
                          // the current version while preserving SHA anchoring
                          // for version boundaries.
                          const fromVersionSha = fromVersion.sha;
                          const pushTime = new Date(
                            toVersion.pushedAt
                          ).getTime();
                          const matchIdx = entries.findIndex(
                            (e) =>
                              e.type === "version_event" &&
                              "commit_id" in e.event &&
                              (e.event as { commit_id?: string }).commit_id ===
                                fromVersionSha
                          );
                          let insertIdx = entries.length;
                          if (matchIdx !== -1) {
                            for (
                              let j = matchIdx + 1;
                              j < entries.length;
                              j++
                            ) {
                              const e = entries[j];
                              // Version boundary — insert before it
                              if (e.type === "version_event") {
                                insertIdx = j;
                                break;
                              }
                              // Entry with a timestamp after the push — insert before it
                              const t = entryTimestamp(e);
                              if (t && t > pushTime) {
                                insertIdx = j;
                                break;
                              }
                            }
                          }
                          entries.splice(insertIdx, 0, synEntry);
                        }
                      }
                    }

                    // Add any orphaned threads that weren't part of a review
                    orphanedThreads.forEach((thread) => {
                      if (thread.comments.nodes[0]) {
                        entries.push({ type: "thread", data: thread });
                      }
                    });

                    return entries.map((entry, index) => {
                      if (entry.type === "comment") {
                        const comment = entry.data;
                        const commentId = `issuecomment-${comment.id}`;
                        return (
                          <CommentBox
                            key={`comment-${comment.id}`}
                            id={commentId}
                            user={comment.user}
                            createdAt={comment.created_at}
                            updatedAt={comment.updated_at}
                            commentUrl={comment.html_url}
                            body={comment.body ?? null}
                            bodyHtml={comment.body_html}
                            isAuthor={comment.user?.login === currentUser}
                            reactions={reactions[`comment-${comment.id}`]}
                            onAddReaction={
                              canWrite
                                ? (content) =>
                                    handleAddCommentReaction(
                                      comment.id,
                                      content
                                    )
                                : undefined
                            }
                            onRemoveReaction={
                              canWrite
                                ? (reactionId) =>
                                    handleRemoveCommentReaction(
                                      comment.id,
                                      reactionId
                                    )
                                : undefined
                            }
                            currentUser={currentUser}
                            isFocused={focusedOverviewItemId === commentId}
                            onQuote={
                              canWrite
                                ? handleQuoteConversationComment
                                : undefined
                            }
                            onEdit={
                              canWrite && comment.user?.login === currentUser
                                ? (body) => handleEditComment(comment.id, body)
                                : undefined
                            }
                            onDelete={
                              canWrite && comment.user?.login === currentUser
                                ? () => handleDeleteComment(comment.id)
                                : undefined
                            }
                          />
                        );
                      }
                      if (entry.type === "review") {
                        return (
                          <div
                            key={`review-${entry.data.id}`}
                            className="space-y-3"
                          >
                            <ReviewBox review={entry.data} />
                            {/* Render associated threads under the review */}
                            {entry.threads.map((thread) => {
                              const threadId = `reviewthread-${thread.id}`;
                              return (
                                <ReviewThreadBox
                                  key={`thread-${thread.id}`}
                                  thread={thread}
                                  owner={owner}
                                  repo={repo}
                                  prNumber={pr.number}
                                  onReply={handleReplyToThread}
                                  onResolve={handleResolveThread}
                                  onUnresolve={handleUnresolveThread}
                                  canWrite={canWrite}
                                  canResolveThread={canResolveThread}
                                  currentUser={currentUser}
                                  onAddReaction={handleAddReviewCommentReaction}
                                  onRemoveReaction={
                                    handleRemoveReviewCommentReaction
                                  }
                                  reactions={Object.fromEntries(
                                    thread.comments.nodes.map((c) => [
                                      c.databaseId,
                                      reactions[
                                        `review-comment-${c.databaseId}`
                                      ] || [],
                                    ])
                                  )}
                                  isFocused={focusedOverviewItemId === threadId}
                                  autoFocusReply={
                                    replyingToOverviewItem === threadId
                                  }
                                  onEditComment={handleEditReviewComment}
                                  onDeleteComment={handleDeleteReviewComment}
                                />
                              );
                            })}
                          </div>
                        );
                      }
                      if (entry.type === "event") {
                        return (
                          <TimelineItem
                            key={`event-${index}`}
                            event={entry.data}
                            pr={pr}
                            pushVersions={pushVersions}
                            versionDiffCounts={versionDiffCounts}
                            versionRebaseInfo={versionRebaseInfo}
                            onNavigateChecks={handleNavigateChecks}
                          />
                        );
                      }
                      if (entry.type === "version_event") {
                        const versionSha = (
                          entry.event as { commit_id?: string }
                        ).commit_id;
                        return (
                          <div key={`version-${index}`}>
                            <TimelineItem
                              event={entry.event}
                              pr={pr}
                              pushVersions={pushVersions}
                              versionDiffCounts={versionDiffCounts}
                              versionRebaseInfo={versionRebaseInfo}
                              onNavigateChecks={handleNavigateChecks}
                            />
                            {entry.commits.length > 0 && (
                              <CommitList
                                commits={entry.commits}
                                owner={owner}
                                repo={repo}
                                onNavigate={handleNavigateCommit}
                                versionSha={versionSha}
                              />
                            )}
                          </div>
                        );
                      }
                      if (entry.type === "commits") {
                        return (
                          <CommitGroup
                            key={`commits-${index}`}
                            commits={entry.data}
                            prCommits={commits}
                            owner={owner}
                            repo={repo}
                            onNavigate={handleNavigateCommit}
                          />
                        );
                      }
                      if (entry.type === "thread") {
                        // Orphaned thread (no associated review)
                        const threadId = `reviewthread-${entry.data.id}`;
                        return (
                          <ReviewThreadBox
                            key={`thread-${entry.data.id}`}
                            thread={entry.data}
                            owner={owner}
                            repo={repo}
                            prNumber={pr.number}
                            onReply={handleReplyToThread}
                            onResolve={handleResolveThread}
                            onUnresolve={handleUnresolveThread}
                            canWrite={canWrite}
                            canResolveThread={canResolveThread}
                            currentUser={currentUser}
                            onAddReaction={handleAddReviewCommentReaction}
                            onRemoveReaction={handleRemoveReviewCommentReaction}
                            reactions={Object.fromEntries(
                              entry.data.comments.nodes.map((c) => [
                                c.databaseId,
                                reactions[`review-comment-${c.databaseId}`] ||
                                  [],
                              ])
                            )}
                            isFocused={focusedOverviewItemId === threadId}
                            autoFocusReply={replyingToOverviewItem === threadId}
                            onEditComment={handleEditReviewComment}
                            onDeleteComment={handleDeleteReviewComment}
                          />
                        );
                      }
                      return null;
                    });
                  })()}
                </div>

                {/* Archived repo notice */}
                {isArchived && pr.state === "open" && !pr.merged && (
                  <div className="flex items-center gap-2 py-3 px-4 bg-yellow-500/10 border border-yellow-500/20 rounded-md">
                    <Lock className="w-4 h-4 text-yellow-500" />
                    <span className="text-sm text-yellow-200">
                      This repository has been archived. No changes can be made.
                    </span>
                  </div>
                )}

                {/* Merge Section - show to all users for open PRs */}
                {pr.state === "open" && !pr.merged && (
                  <>
                    <MergeSection
                      pr={pr}
                      checkStatus={checkStatus}
                      checks={checks}
                      canMerge={canMergePR}
                      canMergeRepo={canMergeRepo}
                      merging={merging}
                      mergeMethod={mergeMethod}
                      showMergeOptions={showMergeOptions}
                      mergeError={mergeError}
                      latestReviews={latestReviews}
                      hasMergeQueue={repoHasMergeQueue}
                      inMergeQueue={prInMergeQueue}
                      dequeueing={dequeueing}
                      onDequeue={handleDequeue}
                      onMerge={handleMerge}
                      onSetMergeMethod={store.setMergeMethod}
                      onToggleMergeOptions={() =>
                        setShowMergeOptions(!showMergeOptions)
                      }
                      onUpdateBranch={handleUpdateBranch}
                      markingReady={markingReady}
                      onMarkReadyForReview={handleMarkReadyForReview}
                      markingReadyError={markingReadyError}
                      workflowRunsAwaitingApproval={
                        workflowRunsAwaitingApproval
                      }
                      approvingWorkflows={approvingWorkflows}
                      onApproveWorkflows={handleApproveWorkflows}
                      canBypassBranchProtections={viewerCanMergeAsAdmin}
                    />
                    {/* Still in progress - only show if NOT a draft and user can merge */}
                    {canMergeRepo && !pr.draft && (
                      <div className="flex justify-end">
                        <p className="text-sm text-muted-foreground">
                          Still in progress?{" "}
                          <button
                            onClick={handleConvertToDraft}
                            disabled={convertingToDraft}
                            className="text-blue-400 hover:underline disabled:opacity-50"
                          >
                            {convertingToDraft
                              ? "Converting..."
                              : "Convert to draft"}
                          </button>
                        </p>
                        {convertingToDraftError && (
                          <p className="text-sm text-destructive mt-1">
                            {convertingToDraftError}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* Successfully merged and closed - show for merged PRs */}
                {pr.merged &&
                  (() => {
                    // Check if the head branch is from a fork (different repo than base)
                    const isFromFork =
                      pr.head.repo?.full_name !== pr.base.repo?.full_name;
                    return (
                      <div className="border border-purple-500/30 rounded-md overflow-hidden bg-purple-500/10">
                        <div className="flex items-start gap-3 p-4">
                          <div className="p-2 rounded-full bg-purple-500/20 text-purple-400 shrink-0">
                            <GitMerge className="w-5 h-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="font-semibold">
                              Pull request successfully merged and closed
                            </h3>
                            <p className="text-sm text-muted-foreground mt-1">
                              {isFromFork ? (
                                <>
                                  The{" "}
                                  <code className="break-all px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">
                                    {pr.head.label || pr.head.ref}
                                  </code>{" "}
                                  branch is in a fork and cannot be deleted from
                                  here.
                                </>
                              ) : (
                                <>
                                  You're all set — the{" "}
                                  <code className="break-all px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">
                                    {pr.head.label || pr.head.ref}
                                  </code>{" "}
                                  branch can be safely deleted.
                                </>
                              )}
                            </p>
                            <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-3">
                              {canMergeRepo &&
                                !branchDeleted &&
                                !isFromFork && (
                                  <button
                                    onClick={handleDeleteBranch}
                                    disabled={deletingBranch}
                                    className="shrink-0 px-4 py-2 border border-border text-sm font-medium rounded-md hover:bg-muted/50 transition-colors disabled:opacity-50"
                                  >
                                    {deletingBranch ? (
                                      <span className="flex items-center gap-2">
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Deleting...
                                      </span>
                                    ) : (
                                      "Delete branch"
                                    )}
                                  </button>
                                )}
                              {branchDeleted && !isFromFork && (
                                <>
                                  <span className="text-sm text-muted-foreground inline-flex items-center gap-2">
                                    <Check className="w-4 h-4 text-green-400 shrink-0" />
                                    <span>Deleted</span>
                                    <code className="break-all min-w-0 px-1.5 py-0.5 bg-muted rounded text-xs">
                                      {pr.head.ref}
                                    </code>
                                  </span>
                                  {canMergeRepo && (
                                    <button
                                      onClick={handleRestoreBranch}
                                      disabled={restoringBranch}
                                      className="shrink-0 px-3 py-1.5 border border-border text-sm font-medium rounded-md hover:bg-muted/50 transition-colors disabled:opacity-50"
                                    >
                                      {restoringBranch ? (
                                        <span className="flex items-center gap-2">
                                          <Loader2 className="w-4 h-4 animate-spin" />
                                          Restoring...
                                        </span>
                                      ) : (
                                        "Restore branch"
                                      )}
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                {/* Closed with unmerged commits - show for closed, unmerged PRs */}
                {pr.state === "closed" && !pr.merged && (
                  <div className="border border-border rounded-md overflow-hidden">
                    <div className="flex items-start gap-3 p-4 bg-card/30">
                      <div className="p-2 rounded-full bg-purple-500/10 text-purple-400 shrink-0">
                        <GitBranch className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold">
                          Closed with unmerged commits
                        </h3>
                        <p className="text-sm text-muted-foreground mt-1">
                          This pull request is closed, but the{" "}
                          <code className="break-all px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">
                            {pr.head.ref}
                          </code>{" "}
                          branch has unmerged commits.
                        </p>
                        <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-3">
                          {canMergeRepo && !branchDeleted && (
                            <button
                              onClick={handleDeleteBranch}
                              disabled={deletingBranch}
                              className="shrink-0 px-4 py-2 border border-border text-sm font-medium rounded-md hover:bg-muted/50 transition-colors disabled:opacity-50"
                            >
                              {deletingBranch ? (
                                <span className="flex items-center gap-2">
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                  Deleting...
                                </span>
                              ) : (
                                "Delete branch"
                              )}
                            </button>
                          )}
                          {branchDeleted && (
                            <>
                              <span className="text-sm text-muted-foreground inline-flex items-center gap-2">
                                <Check className="w-4 h-4 text-green-400 shrink-0" />
                                <span>Deleted</span>
                                <code className="break-all min-w-0 px-1.5 py-0.5 bg-muted rounded text-xs">
                                  {pr.head.ref}
                                </code>
                              </span>
                              {canMergeRepo && (
                                <button
                                  onClick={handleRestoreBranch}
                                  disabled={restoringBranch}
                                  className="shrink-0 px-3 py-1.5 border border-border text-sm font-medium rounded-md hover:bg-muted/50 transition-colors disabled:opacity-50"
                                >
                                  {restoringBranch ? (
                                    <span className="flex items-center gap-2">
                                      <Loader2 className="w-4 h-4 animate-spin" />
                                      Restoring...
                                    </span>
                                  ) : (
                                    "Restore branch"
                                  )}
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    {canMergeRepo && (
                      <div className="px-4 py-3 border-t border-border bg-card/10 flex items-center justify-end">
                        <button
                          onClick={handleReopenPR}
                          disabled={reopeningPR}
                          className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
                        >
                          {reopeningPR ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <GitPullRequest className="w-4 h-4" />
                          )}
                          {reopeningPR ? "Reopening..." : "Reopen pull request"}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {overviewLoading && (
                  <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading timeline&hellip;
                  </div>
                )}

                {/* Add a comment - only show when user can write (comments allowed even without push) */}
                {canWrite ? (
                  <div id="conversation-comment-box" className="flex gap-3">
                    {/* Avatar */}
                    {currentUser && (
                      <img
                        src={`https://avatars.githubusercontent.com/${currentUser}`}
                        alt={currentUser}
                        className="w-10 h-10 rounded-full shrink-0"
                      />
                    )}
                    <div className="flex-1 flex flex-col gap-2">
                      <MarkdownEditor
                        value={commentText}
                        onChange={setCommentText}
                        onKeyDown={handleCommentKeyDown}
                        placeholder="Add your comment here..."
                        minHeight="100px"
                      />
                      <div className="flex items-center justify-end gap-2">
                        {canMergeRepo && pr.state === "open" && !pr.merged && (
                          <button
                            onClick={handleClosePR}
                            disabled={closingPR}
                            className="flex items-center gap-2 px-3 py-1.5 border border-red-500/50 text-red-400 rounded-md hover:bg-red-500/10 transition-colors text-sm font-medium disabled:opacity-50"
                          >
                            {closingPR ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <GitPullRequest className="w-4 h-4" />
                            )}
                            {closingPR ? "Closing..." : "Close pull request"}
                          </button>
                        )}
                        <button
                          onClick={handleAddComment}
                          disabled={!commentText.trim() || submittingComment}
                          className="flex items-center gap-2 px-3 py-1.5 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors disabled:opacity-50 text-sm font-medium"
                        >
                          {submittingComment ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : null}
                          Comment
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 py-3 px-4 bg-amber-500/10 border border-amber-500/20 rounded-md">
                    <MessageSquare className="w-4 h-4 text-amber-500" />
                    <span className="text-sm text-amber-200">
                      Sign in to leave comments
                    </span>
                  </div>
                )}
              </>
            )}

            {activeTab === "commits" && (
              <CommitsTab commits={commits} owner={owner} repo={repo} />
            )}

            {activeTab === "checks" && (
              <ChecksTab
                checks={checks}
                lastUpdated={checksLastUpdated}
                onRefresh={handleRefreshChecks}
                refreshing={refreshingChecks}
              />
            )}
          </div>

          {/* Right Column - Sidebar */}
          <div className="w-full md:w-[296px] shrink-0 space-y-4 order-1 md:order-2">
            {/* Reviewers */}
            <SidebarSection
              title="Reviewers"
              action={
                canMergeRepo && !pr.merged ? (
                  <button
                    ref={reviewersButtonRef}
                    onClick={handleToggleReviewersPicker}
                    className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-muted transition-colors"
                    title="Request reviewers"
                  >
                    <Settings className="w-3.5 h-3.5" />
                  </button>
                ) : undefined
              }
            >
              <TooltipProvider delayDuration={200}>
                <div className="space-y-2">
                  {allReviewers.length > 0 ? (
                    allReviewers.map((reviewer) => (
                      <div
                        key={reviewer.login}
                        className="flex items-center gap-2 group"
                      >
                        {reviewer.isTeam ? (
                          <Users className="w-5 h-5 p-0.5 rounded-full text-muted-foreground shrink-0" />
                        ) : (
                          <UserHoverCard login={reviewer.login}>
                            <img
                              src={reviewer.avatar_url}
                              alt={reviewer.login}
                              className="w-5 h-5 rounded-full cursor-pointer"
                            />
                          </UserHoverCard>
                        )}
                        {reviewer.isTeam ? (
                          <span className="text-sm flex-1 font-medium text-muted-foreground">
                            {reviewer.login}
                          </span>
                        ) : (
                          <UserHoverCard login={reviewer.login}>
                            <span className="text-sm flex-1 hover:text-blue-400 hover:underline cursor-pointer">
                              {reviewer.login}
                            </span>
                          </UserHoverCard>
                        )}
                        {reviewer.state === "PENDING" ? (
                          <>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="ml-auto cursor-default">
                                  <Clock className="w-3.5 h-3.5 text-yellow-500" />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                {reviewer.isTeam
                                  ? "Awaiting review from this team"
                                  : "Awaiting review from this user"}
                              </TooltipContent>
                            </Tooltip>
                            {!reviewer.isTeam && canMergeRepo && !pr.merged && (
                              <button
                                onClick={() =>
                                  handleRemoveReviewer(reviewer.login)
                                }
                                className="p-0.5 text-muted-foreground hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                                title="Remove reviewer"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </>
                        ) : (
                          <ReviewStateIcon state={reviewer.state} showTooltip />
                        )}
                      </div>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      No reviews yet
                    </span>
                  )}
                </div>
              </TooltipProvider>
              {pr.state === "open" && !pr.merged && (
                <div className="mt-2 pt-2 border-t border-border">
                  <p className="text-xs text-muted-foreground">
                    {latestReviews.some((r) => r.state === "APPROVED")
                      ? "This pull request has been approved."
                      : "At least 1 approving review is required to merge this pull request."}
                  </p>
                </div>
              )}
            </SidebarSection>

            {/* Reviewers Picker */}
            {showReviewersPicker && (
              <>
                <div
                  className="fixed inset-0 z-[100]"
                  onClick={() => setShowReviewersPicker(false)}
                />
                <div
                  className="fixed w-[260px] bg-card border border-border rounded-md shadow-xl z-[101] overflow-hidden"
                  style={{
                    top: reviewersPickerPosition.top,
                    left: reviewersPickerPosition.left,
                  }}
                >
                  <div className="px-3 py-2 border-b border-border space-y-2">
                    <p className="text-sm font-medium">Request reviewers</p>
                    <input
                      ref={reviewerSearchInputRef}
                      type="text"
                      placeholder="Search users..."
                      value={reviewerSearchQuery}
                      onChange={(e) => setReviewerSearchQuery(e.target.value)}
                      className="w-full px-2 py-1.5 text-sm bg-muted border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div className="max-h-[300px] overflow-auto">
                    {loadingCollaborators ? (
                      <div className="p-4 text-center text-sm text-muted-foreground">
                        <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                      </div>
                    ) : (
                      collaborators
                        .filter(
                          (c) =>
                            c.login !== pr.user?.login &&
                            !pr.requested_reviewers?.some(
                              (r) => r.login === c.login
                            ) &&
                            c.login
                              .toLowerCase()
                              .includes(reviewerSearchQuery.toLowerCase())
                        )
                        .map((collaborator) => (
                          <button
                            key={collaborator.login}
                            onClick={() => {
                              handleRequestReviewer(collaborator.login);
                              setShowReviewersPicker(false);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted transition-colors text-left"
                          >
                            <img
                              src={collaborator.avatar_url}
                              alt={collaborator.login}
                              className="w-5 h-5 rounded-full"
                            />
                            <span className="text-sm">
                              {collaborator.login}
                            </span>
                          </button>
                        ))
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Assignees */}
            <SidebarSection
              title="Assignees"
              action={
                canMergeRepo && !pr.merged ? (
                  <button
                    ref={assigneesButtonRef}
                    onClick={handleToggleAssigneesPicker}
                    className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-muted transition-colors"
                    title="Edit assignees"
                  >
                    <Settings className="w-3.5 h-3.5" />
                  </button>
                ) : undefined
              }
            >
              {pr.assignees && pr.assignees.length > 0 ? (
                <div className="space-y-2">
                  {pr.assignees.map((assignee) => (
                    <div
                      key={assignee.login}
                      className="flex items-center gap-2 group"
                    >
                      <UserHoverCard login={assignee.login}>
                        <img
                          src={assignee.avatar_url}
                          alt={assignee.login}
                          className="w-5 h-5 rounded-full cursor-pointer"
                        />
                      </UserHoverCard>
                      <UserHoverCard login={assignee.login}>
                        <span className="text-sm flex-1 hover:text-blue-400 hover:underline cursor-pointer">
                          {assignee.login}
                        </span>
                      </UserHoverCard>
                      {canMergeRepo && !pr.merged && (
                        <button
                          onClick={() => handleRemoveAssignee(assignee.login)}
                          className="p-0.5 text-muted-foreground hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Remove assignee"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">
                  No one—
                  {canMergeRepo && !pr.merged ? (
                    <button
                      onClick={handleAssignSelf}
                      disabled={assigningSelf}
                      className="text-blue-400 hover:underline disabled:opacity-50"
                    >
                      {assigningSelf ? "assigning..." : "assign yourself"}
                    </button>
                  ) : null}
                </span>
              )}
            </SidebarSection>

            {/* Assignees Picker */}
            {showAssigneesPicker && (
              <>
                <div
                  className="fixed inset-0 z-[100]"
                  onClick={() => setShowAssigneesPicker(false)}
                />
                <div
                  className="fixed w-[260px] bg-card border border-border rounded-md shadow-xl z-[101] overflow-hidden"
                  style={{
                    top: assigneesPickerPosition.top,
                    left: assigneesPickerPosition.left,
                  }}
                >
                  <div className="px-3 py-2 border-b border-border space-y-2">
                    <p className="text-sm font-medium">Assign people</p>
                    <input
                      ref={assigneeSearchInputRef}
                      type="text"
                      placeholder="Search users..."
                      value={assigneeSearchQuery}
                      onChange={(e) => setAssigneeSearchQuery(e.target.value)}
                      className="w-full px-2 py-1.5 text-sm bg-muted border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div className="max-h-[300px] overflow-auto">
                    {loadingCollaborators ? (
                      <div className="p-4 text-center text-sm text-muted-foreground">
                        <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                      </div>
                    ) : (
                      collaborators
                        .filter(
                          (c) =>
                            !pr.assignees?.some((a) => a.login === c.login) &&
                            c.login
                              .toLowerCase()
                              .includes(assigneeSearchQuery.toLowerCase())
                        )
                        .map((collaborator) => (
                          <button
                            key={collaborator.login}
                            onClick={() => {
                              handleAddAssignee(collaborator.login);
                              setShowAssigneesPicker(false);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted transition-colors text-left"
                          >
                            <img
                              src={collaborator.avatar_url}
                              alt={collaborator.login}
                              className="w-5 h-5 rounded-full"
                            />
                            <span className="text-sm">
                              {collaborator.login}
                            </span>
                          </button>
                        ))
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Labels */}
            <LabelsSection
              pr={pr}
              owner={owner}
              repo={repo}
              onLabelToggle={async (labelName, labelColor, hasLabel) => {
                try {
                  // 1. Request GitHub to toggle label
                  if (hasLabel) {
                    await github.removeLabel(owner, repo, pr.number, labelName);
                  } else {
                    await github.addLabels(owner, repo, pr.number, [labelName]);
                  }

                  // 2. Update our state with the known change
                  const newLabels = hasLabel
                    ? pr.labels.filter((l) => l.name !== labelName)
                    : [
                        ...pr.labels,
                        {
                          id: 0,
                          node_id: "",
                          url: "",
                          name: labelName,
                          color: labelColor,
                          default: false,
                          description: null,
                        },
                      ];
                  store.setPr({ ...pr, labels: newLabels });

                  // 3. Invalidate cache so future fetches get fresh data
                  github.invalidatePR(owner, repo, pr.number);

                  // 4. Refetch timeline (label change creates event)
                  github
                    .getPRTimeline(owner, repo, pr.number)
                    .then((timeline) => store.setTimeline(timeline))
                    .catch(() => {});
                } catch (error) {
                  console.error("Failed to toggle label:", error);
                }
              }}
              canWrite={canMergeRepo}
            />

            {/* Participants */}
            <SidebarSection
              title={`${participants.length} participant${participants.length !== 1 ? "s" : ""}`}
            >
              <div className="flex items-center gap-1 flex-wrap">
                {participants.map((user) => (
                  <UserHoverCard key={user.login} login={user.login}>
                    <img
                      src={user.avatar_url}
                      alt={user.login}
                      className="w-6 h-6 rounded-full cursor-pointer ring-1 ring-transparent hover:ring-border transition-all"
                    />
                  </UserHoverCard>
                ))}
              </div>
            </SidebarSection>

            {/* Actions */}
            <div className="pt-2 border-t border-border space-y-2">
              <a
                href={`https://github.com/${owner}/${repo}/pull/${pr.number}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-muted-foreground hover:text-blue-400"
              >
                <ExternalLink className="w-4 h-4" />
                View on GitHub
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

// ============================================================================
// Tab Button Component
// ============================================================================

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
  extra,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
  extra?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 sm:gap-2 px-2 sm:px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
        active
          ? "border-orange-500 text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
      )}
    >
      {icon}
      <span className="hidden xs:inline sm:inline">{label}</span>
      {count !== undefined && count > 0 && (
        <span
          className={cn(
            "px-1.5 py-0.5 text-xs rounded-full",
            active ? "bg-muted" : "bg-muted/50"
          )}
        >
          {count}
        </span>
      )}
      {extra}
    </button>
  );
}

// ============================================================================
// Sidebar Section Component
// ============================================================================

function SidebarSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="pb-3 border-b border-border">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

// ============================================================================
// Labels Section Component
// ============================================================================

interface LabelsSectionProps {
  pr: PullRequest;
  owner: string;
  repo: string;
  onLabelToggle: (
    labelName: string,
    labelColor: string,
    hasLabel: boolean
  ) => Promise<void>;
  canWrite?: boolean;
}

function LabelsSection({
  pr,
  owner,
  repo,
  onLabelToggle,
  canWrite = true,
}: LabelsSectionProps) {
  const { ready } = useGitHubReady();
  const { data: repoLabels = [], isLoading: loadingLabels } = useQuery({
    ...queries.labels(owner, repo),
    enabled: ready,
  });
  const [showPicker, setShowPicker] = useState(false);
  const [pickerPosition, setPickerPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleTogglePicker = useCallback(() => {
    if (!showPicker && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPickerPosition({
        top: rect.bottom + 4,
        left: Math.min(rect.left, window.innerWidth - 280),
      });
    }
    setShowPicker(!showPicker);
  }, [showPicker]);

  const handleToggleLabel = useCallback(
    async (labelName: string, labelColor: string) => {
      const hasLabel = pr.labels.some((l) => l.name === labelName);
      await onLabelToggle(labelName, labelColor, hasLabel);
    },
    [pr.labels, onLabelToggle]
  );

  const canEdit = canWrite && pr.state === "open" && !pr.merged;

  return (
    <SidebarSection
      title="Labels"
      action={
        canEdit ? (
          <button
            ref={buttonRef}
            onClick={handleTogglePicker}
            className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-muted transition-colors"
            title="Edit labels"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        ) : undefined
      }
    >
      {pr.labels.length > 0 ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          {pr.labels.map((label) => (
            <span
              key={label.name}
              className="px-2 py-0.5 text-xs font-medium rounded-full"
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
      ) : (
        <span className="text-sm text-muted-foreground">None yet</span>
      )}

      {/* Labels Picker */}
      {showPicker && (
        <>
          <div
            className="fixed inset-0 z-[100]"
            onClick={() => setShowPicker(false)}
          />
          <div
            className="fixed w-[260px] bg-card border border-border rounded-md shadow-xl z-[101] overflow-hidden"
            style={{ top: pickerPosition.top, left: pickerPosition.left }}
          >
            <div className="px-3 py-2 border-b border-border">
              <p className="text-sm font-medium">Apply labels</p>
            </div>
            <div className="max-h-[300px] overflow-auto">
              {loadingLabels ? (
                <div className="p-4 text-center text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                </div>
              ) : (
                repoLabels.map((label) => {
                  const isApplied = pr.labels.some(
                    (l) => l.name === label.name
                  );
                  return (
                    <button
                      key={label.name}
                      onClick={() => handleToggleLabel(label.name, label.color)}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted transition-colors text-left"
                    >
                      <div className="w-4 h-4 flex items-center justify-center">
                        {isApplied && (
                          <Check className="w-3.5 h-3.5 text-green-500" />
                        )}
                      </div>
                      <span
                        className="px-2 py-0.5 text-xs font-medium rounded-full"
                        style={{
                          backgroundColor: `#${label.color}20`,
                          color: `#${label.color}`,
                          border: `1px solid #${label.color}40`,
                        }}
                      >
                        {label.name}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}
    </SidebarSection>
  );
}

// ============================================================================
// Comment Box Component
// ============================================================================

function CommentBox({
  id,
  user,
  createdAt,
  updatedAt,
  commentUrl,
  body,
  bodyHtml,
  isAuthor,
  reactions,
  onAddReaction,
  onRemoveReaction,
  currentUser,
  isFocused,
  onQuote,
  onEdit,
  onDelete,
}: {
  id?: string;
  user: { login: string; avatar_url: string } | null;
  createdAt: string;
  updatedAt?: string;
  commentUrl?: string;
  body: string | null;
  /** Pre-rendered HTML with signed attachment URLs from GitHub's API */
  bodyHtml?: string;
  isAuthor?: boolean;
  reactions?: Reaction[];
  onAddReaction?: (content: ReactionContent) => void;
  onRemoveReaction?: (reactionId: number) => void;
  currentUser?: string | null;
  isFocused?: boolean;
  onQuote?: (body: string) => void;
  onEdit?: (body: string) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = React.useState("");
  const [saving, setSaving] = useState(false);

  const handleStartEdit = useCallback(() => {
    setEditText(body ?? "");
    setEditing(true);
  }, [body]);

  const handleCancelEdit = useCallback(() => {
    setEditing(false);
    setEditText("");
  }, []);

  const handleSave = useCallback(async () => {
    if (!editText.trim() || !onEdit) return;
    setSaving(true);
    try {
      await onEdit(editText.trim());
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [editText, onEdit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        handleCancelEdit();
      }
    },
    [handleCancelEdit]
  );

  if (!user) return null;

  return (
    <div
      id={id}
      className={cn(
        "relative z-10 border border-border rounded-md overflow-hidden bg-card",
        isFocused && "ring-2 ring-blue-500"
      )}
    >
      {/* Header */}
      <div
        className={cn(
          "flex items-center gap-2 px-4 py-2 text-sm border-b border-border bg-card",
          isAuthor && "bg-blue-500/10"
        )}
      >
        <UserHoverCard login={user.login}>
          <img
            src={user.avatar_url}
            alt={user.login}
            className="w-5 h-5 rounded-full cursor-pointer"
          />
        </UserHoverCard>
        <UserHoverCard login={user.login}>
          <span className="font-semibold hover:text-blue-400 hover:underline cursor-pointer">
            {user.login}
          </span>
        </UserHoverCard>
        <span className="text-muted-foreground">
          commented{" "}
          {commentUrl ? (
            <a
              href={commentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              {getTimeAgo(new Date(createdAt))}
            </a>
          ) : (
            getTimeAgo(new Date(createdAt))
          )}
        </span>
        {updatedAt && updatedAt !== createdAt && (
          <span className="text-muted-foreground">
            · edited {getTimeAgo(new Date(updatedAt))}
          </span>
        )}
        {isAuthor && (
          <span className="ml-auto px-1.5 py-0.5 text-xs border border-border rounded text-muted-foreground">
            Author
          </span>
        )}
      </div>
      {/* Body */}
      <div className="p-4 bg-card">
        {editing ? (
          <div className="space-y-3">
            <MarkdownEditor
              value={editText}
              onChange={setEditText}
              onKeyDown={handleKeyDown}
              placeholder="Edit your comment..."
              minHeight="60px"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={handleCancelEdit}
                className="px-3 py-1.5 text-sm rounded-md hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!editText.trim() || saving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                <Check className="w-3.5 h-3.5" />
                Save
              </button>
            </div>
          </div>
        ) : body || bodyHtml ? (
          <Markdown
            html={bodyHtml}
            emptyState={
              <p className="text-sm text-muted-foreground italic">
                No description provided.
              </p>
            }
          >
            {body ?? ""}
          </Markdown>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            No description provided.
          </p>
        )}
      </div>
      {/* Reactions + Actions */}
      {reactions ||
      onAddReaction ||
      onQuote ||
      (isAuthor && (onEdit || onDelete)) ? (
        <div className="px-4 py-2 border-t border-border bg-card flex items-center gap-1">
          <EmojiReactions
            reactions={reactions || []}
            onAddReaction={onAddReaction}
            onRemoveReaction={onRemoveReaction}
            currentUser={currentUser}
          />
          <div className="ml-auto flex items-center gap-3">
            {onQuote && (
              <button
                onClick={() => onQuote(body ?? "")}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                title="Reply"
              >
                <Reply className="w-3 h-3" />
                Reply
              </button>
            )}
            {isAuthor && onEdit && !editing && (
              <button
                onClick={handleStartEdit}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                title="Edit"
              >
                <Pencil className="w-3 h-3" />
                Edit
              </button>
            )}
            {isAuthor && onDelete && !editing && (
              <button
                onClick={onDelete}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors"
                title="Delete"
              >
                <Trash2 className="w-3 h-3" />
                Delete
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ============================================================================
// Review Box Component
// ============================================================================

function ReviewBox({ review }: { review: Review }) {
  const store = usePRReviewStore();
  const github = useGitHub();
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const prNumber = usePRReviewSelector((s) => s.pr.number);
  const currentUser = useCurrentUser()?.login ?? null;
  const viewerPermission = usePRReviewSelector((s) => s.viewerPermission);
  const canWrite =
    viewerPermission === "ADMIN" ||
    viewerPermission === "MAINTAIN" ||
    viewerPermission === "WRITE";
  const [reactions, setReactions] = useState<Reaction[]>([]);

  // Fetch reactions via GraphQL using the review's node_id
  useEffect(() => {
    if (review.node_id) {
      github
        .getReviewReactions(review.node_id)
        .then(setReactions)
        .catch(() => {});
    }
  }, [github, review.node_id]);

  const handleAddReaction = useCallback(
    async (content: ReactionContent) => {
      if (!review.node_id) return;
      try {
        const newReaction = await github.addReviewReaction(
          review.node_id,
          content
        );
        setReactions((prev) => [...prev, newReaction]);
      } catch (error) {
        console.error("Failed to add reaction:", error);
      }
    },
    [github, review.node_id]
  );

  const handleRemoveReaction = useCallback(
    async (reactionId: number) => {
      if (!review.node_id) return;
      // Find the reaction by database ID to get its node_id for deletion
      const reaction = reactions.find((r) => r.id === reactionId);
      if (!reaction?.node_id) return;
      try {
        await github.deleteReviewReaction(reaction.node_id);
        setReactions((prev) => prev.filter((r) => r.id !== reactionId));
      } catch (error) {
        console.error("Failed to remove reaction:", error);
      }
    },
    [github, review.node_id, reactions]
  );

  if (!review.user) return null;

  const stateText =
    {
      APPROVED: "approved these changes",
      CHANGES_REQUESTED: "requested changes",
      COMMENTED: "reviewed",
      DISMISSED: "dismissed review",
      PENDING: "started a review",
    }[review.state] || "reviewed";

  // Icon color for timeline circle
  const iconColor =
    {
      APPROVED: "text-green-500",
      CHANGES_REQUESTED: "text-red-500",
      COMMENTED: "text-muted-foreground",
      DISMISSED: "text-muted-foreground",
      PENDING: "text-yellow-500",
    }[review.state] || "text-muted-foreground";

  // Border color for comment box
  const stateBorder =
    {
      APPROVED: "border-green-500/30",
      CHANGES_REQUESTED: "border-red-500/30",
      COMMENTED: "",
      DISMISSED: "",
      PENDING: "border-yellow-500/30",
    }[review.state] || "";

  // Header background for comment box
  const stateHeaderBg =
    {
      APPROVED: "bg-green-500/10",
      CHANGES_REQUESTED: "bg-red-500/10",
      COMMENTED: "",
      DISMISSED: "",
      PENDING: "bg-yellow-500/10",
    }[review.state] || "";

  return (
    <div id={`pullrequestreview-${review.id}`}>
      {/* Timeline header row - like GitHub's "Username reviewed yesterday" */}
      <div className="flex items-center gap-3 py-1.5 text-sm text-muted-foreground">
        <UserHoverCard login={review.user.login}>
          <img
            src={review.user.avatar_url}
            alt={review.user.login}
            className="w-6 h-6 rounded-full cursor-pointer"
          />
        </UserHoverCard>
        <div
          className={cn(
            "relative z-10 p-1.5 rounded-full bg-background border border-border shrink-0",
            iconColor
          )}
        >
          <ReviewStateIcon state={review.state} />
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
          <UserHoverCard login={review.user.login}>
            <span className="font-semibold text-foreground hover:text-blue-400 hover:underline cursor-pointer">
              {review.user.login}
            </span>
          </UserHoverCard>
          <span>{stateText}</span>
          <span
            title={
              review.submitted_at
                ? formatDateTime(new Date(review.submitted_at))
                : undefined
            }
          >
            {review.submitted_at && getTimeAgo(new Date(review.submitted_at))}
          </span>
        </div>
      </div>

      {/* Comment box - shows if there's a body */}
      {review.body && (
        <div
          className={cn(
            "relative z-10 border rounded-md overflow-hidden bg-card ml-8",
            stateBorder
          )}
        >
          <div
            className={cn(
              "flex items-center gap-2 px-4 py-2 text-sm border-b border-border bg-card",
              stateHeaderBg
            )}
          >
            <UserHoverCard login={review.user.login}>
              <img
                src={review.user.avatar_url}
                alt={review.user.login}
                className="w-5 h-5 rounded-full cursor-pointer"
              />
            </UserHoverCard>
            <UserHoverCard login={review.user.login}>
              <span className="font-semibold hover:text-blue-400 hover:underline cursor-pointer">
                {review.user.login}
              </span>
            </UserHoverCard>
            <span className="text-muted-foreground">left a comment</span>
            <span className="flex-1" />
            {review.html_url && (
              <a
                href={review.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="View on GitHub"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
          <div className="p-4 bg-card">
            <Markdown html={review.body_html}>{review.body}</Markdown>
          </div>
          {reactions.length > 0 || canWrite ? (
            <div className="px-4 pb-3 bg-card">
              <EmojiReactions
                reactions={reactions}
                onAddReaction={canWrite ? handleAddReaction : undefined}
                onRemoveReaction={canWrite ? handleRemoveReaction : undefined}
                currentUser={currentUser}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Review State Icon
// ============================================================================

function ReviewStateIcon({
  state,
  showTooltip = false,
}: {
  state: string;
  showTooltip?: boolean;
}) {
  const getIconAndTooltip = () => {
    switch (state) {
      case "APPROVED":
        return {
          icon: <CheckCircle2 className="w-4 h-4 text-green-500" />,
          tooltip: "Approved this pull request",
        };
      case "CHANGES_REQUESTED":
        return {
          icon: <XCircle className="w-4 h-4 text-red-500" />,
          tooltip: "Requested changes to this pull request",
        };
      case "COMMENTED":
        return {
          icon: <Eye className="w-4 h-4" />,
          tooltip: "Left review comments",
        };
      case "DISMISSED":
        return {
          icon: <MinusCircle className="w-4 h-4 text-muted-foreground" />,
          tooltip: "Review was dismissed",
        };
      default:
        return {
          icon: <Circle className="w-4 h-4 text-muted-foreground" />,
          tooltip: "Pending review",
        };
    }
  };

  const { icon, tooltip } = getIconAndTooltip();

  if (!showTooltip) {
    return icon;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="ml-auto cursor-default">{icon}</span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

// ============================================================================
// Review Thread Box Component (for inline code comments)
// ============================================================================

function ReviewThreadBox({
  thread,
  owner,
  repo,
  prNumber,
  onReply,
  onResolve,
  onUnresolve,
  canWrite,
  canResolveThread,
  currentUser,
  onAddReaction,
  onRemoveReaction,
  reactions,
  isFocused,
  autoFocusReply,
  onEditComment,
  onDeleteComment,
}: {
  thread: ReviewThread;
  owner: string;
  repo: string;
  prNumber: number;
  onReply?: (
    threadId: string,
    commentId: number,
    body: string
  ) => Promise<void>;
  onResolve?: (threadId: string) => Promise<void>;
  onUnresolve?: (threadId: string) => Promise<void>;
  canWrite?: boolean;
  /** Whether user can resolve/unresolve threads (requires WRITE, MAINTAIN, or ADMIN permission) */
  canResolveThread?: boolean;
  currentUser?: string | null;
  onAddReaction?: (commentId: number, content: ReactionContent) => void;
  onRemoveReaction?: (commentId: number, reactionId: number) => void;
  reactions?: Record<number, Reaction[]>;
  isFocused?: boolean;
  autoFocusReply?: boolean;
  onEditComment?: (commentId: number, body: string) => Promise<void>;
  onDeleteComment?: (commentId: number) => Promise<void>;
}) {
  const [replyText, setReplyText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [showReplyBox, setShowReplyBox] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [parsedDiff, setParsedDiff] = useState<ParsedDiff | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const comments = thread.comments.nodes;
  const firstComment = comments[0];
  const filePath = firstComment?.path;
  const diffHunk = firstComment?.diffHunk;
  const isMetadataComment = comments.some((c) =>
    isSingleCommentMetadata(c.body)
  );
  const store = usePRReviewStore();
  const metadataContext = useMemo(() => {
    if (!isMetadataComment) return null;
    const info = parseCommitMetadataMarker(firstComment?.body ?? "");
    if (!info) return null;
    const state = store.getSnapshot();
    const commit =
      state.commits.find((c) => c.sha.startsWith(info.sha)) ??
      state.commitsByVersion
        .flatMap((v) => v.commits)
        .find((c) => c.sha.startsWith(info.sha));
    if (!commit) return null;
    const lines = buildMetadataLines(commit);
    const commentIdx = info.line - 1;
    const start = Math.max(0, commentIdx - 4);
    const end = Math.min(lines.length - 1, commentIdx);
    return lines.slice(start, end + 1);
  }, [isMetadataComment, firstComment?.body, store]);
  // Auto-focus reply box when triggered via keyboard
  useEffect(() => {
    if (autoFocusReply && canWrite) {
      setShowReplyBox(true);
    }
  }, [autoFocusReply, canWrite]);

  // Parse diff hunk with syntax highlighting using the worker
  // Note: The worker already adds git diff headers, so we pass diffHunk directly
  useEffect(() => {
    if (!diffHunk || !filePath) {
      setParsedDiff(null);
      return;
    }

    parseDiffCached(diffHunk, filePath)
      .then(setParsedDiff)
      .catch(console.error);
  }, [diffHunk, filePath]);

  // Get diff lines from parsed diff (first hunk), filtered to show only relevant lines
  // GitHub's UI shows ~10 lines of context around the comment, not the entire diff hunk
  const diffHunkData = useMemo(() => {
    const hunk = parsedDiff?.hunks.find((h) => h.type === "hunk");
    if (!hunk || hunk.type !== "hunk" || !firstComment) return null;

    const commentLine = firstComment.line;
    const commentStartLine = firstComment.startLine;

    // If no line info, show all (fallback)
    if (!commentLine) return hunk;

    // Filter lines to show only those around the comment range
    // Show ~4 lines of context before the comment start
    const CONTEXT_LINES = 4;
    const rangeStart = (commentStartLine ?? commentLine) - CONTEXT_LINES;
    const rangeEnd = commentLine;

    const filteredLines = hunk.lines.filter((line) => {
      // Use newLineNumber for additions, oldLineNumber for deletions/context
      const lineNum = line.newLineNumber ?? line.oldLineNumber;
      if (!lineNum) return false;
      return lineNum >= rangeStart && lineNum <= rangeEnd;
    });

    // If filter is too aggressive and removes everything, show original
    if (filteredLines.length === 0) return hunk;

    return {
      ...hunk,
      lines: filteredLines,
    };
  }, [parsedDiff, firstComment]);

  const handleQuoteReply = useCallback((body: string) => {
    const quoted =
      body
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n") + "\n\n";
    setReplyText(quoted);
    setShowReplyBox(true);
  }, []);

  // Early return after all hooks
  if (comments.length === 0 || !firstComment) return null;

  // If resolved and not expanded, show collapsed view
  if (thread.isResolved && !showResolved) {
    return (
      <div className="relative z-10 ml-8 rounded-lg border border-border bg-card overflow-hidden">
        <button
          onClick={() => setShowResolved(true)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm hover:bg-muted/50 transition-colors"
        >
          <span className="font-mono text-muted-foreground">
            {getCommentDisplayPath(firstComment)}
          </span>
          <span className="flex items-center gap-2 text-muted-foreground hover:text-foreground">
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 4a.5.5 0 01.5.5v3h3a.5.5 0 010 1h-3v3a.5.5 0 01-1 0v-3h-3a.5.5 0 010-1h3v-3A.5.5 0 018 4z" />
              <path
                fillRule="evenodd"
                d="M8 15A7 7 0 108 1a7 7 0 000 14zm0 1A8 8 0 108 0a8 8 0 000 16z"
              />
            </svg>
            Show resolved
          </span>
        </button>
      </div>
    );
  }

  const handleSubmitReply = async () => {
    if (!onReply || submitting || !replyText.trim()) return;
    setSubmitting(true);
    try {
      const lastComment = comments[comments.length - 1];
      await onReply(thread.id, lastComment.databaseId, replyText.trim());
      setReplyText("");
      setShowReplyBox(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSubmitReply();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setShowReplyBox(false);
      setReplyText("");
    }
  };

  return (
    <div
      id={`reviewthread-${thread.id}`}
      className={cn(
        "relative z-10 border rounded-md overflow-hidden ml-8 bg-card", // Indented to show as nested under review
        thread.isResolved ? "border-muted" : "border-border",
        isFocused && "ring-2 ring-blue-500"
      )}
    >
      {/* File header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-card border-b border-border text-sm">
        {isMetadataComment ? (
          <span className="font-mono text-muted-foreground">
            Commit metadata
          </span>
        ) : (
          <a
            href={`#file=${encodeURIComponent(filePath)}&L=${firstComment.line}`}
            className="font-mono text-muted-foreground hover:text-blue-400 hover:underline"
          >
            {filePath}
          </a>
        )}
        {thread.isResolved && (
          <button
            onClick={() => setShowResolved(false)}
            className="ml-auto flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Check className="w-3 h-3" />
            Resolved
            {thread.resolvedBy && <span> by {thread.resolvedBy.login}</span>}
            <span className="border-l border-border pl-2">Hide resolved</span>
          </button>
        )}
      </div>

      {/* Commit metadata context */}
      {isMetadataComment && metadataContext && (
        <div className="bg-[var(--code-bg)] border-b border-border overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <tbody>
              {metadataContext.map((ml, i) => {
                const info = parseCommitMetadataMarker(
                  firstComment?.body ?? ""
                );
                const lineNum =
                  (info?.line ?? 0) - metadataContext.length + 1 + i;
                return (
                  <tr key={i}>
                    <td className="w-10 text-right px-2 py-0.5 text-muted-foreground select-none border-r border-border/50" />
                    <td className="w-10 text-right px-2 py-0.5 text-muted-foreground select-none border-r border-border/50">
                      {lineNum}
                    </td>
                    <td
                      className="px-2 py-0.5 whitespace-pre"
                      dangerouslySetInnerHTML={{ __html: ml.html }}
                    />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Code context (diff hunk) with syntax highlighting */}
      {diffHunkData && diffHunkData.type === "hunk" && !isMetadataComment && (
        <div className="bg-[var(--code-bg)] border-b border-border overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <tbody>
              {diffHunkData.lines.map((line, i) => (
                <tr
                  key={i}
                  className={cn(
                    line.type === "insert" && "bg-green-500/15",
                    line.type === "delete" && "bg-red-500/15"
                  )}
                >
                  <td className="w-10 text-right px-2 py-0.5 text-muted-foreground select-none border-r border-border/50">
                    {line.type !== "insert" ? line.oldLineNumber : ""}
                  </td>
                  <td className="w-10 text-right px-2 py-0.5 text-muted-foreground select-none border-r border-border/50">
                    {line.type !== "delete" ? line.newLineNumber : ""}
                  </td>
                  <td className="px-2 py-0.5 whitespace-pre">
                    <span
                      className={cn(
                        "select-none mr-1",
                        line.type === "insert" && "text-green-400",
                        line.type === "delete" && "text-red-400"
                      )}
                    >
                      {line.type === "insert"
                        ? "+"
                        : line.type === "delete"
                          ? "-"
                          : " "}
                    </span>
                    {line.content.map((seg, j) => (
                      <span
                        key={j}
                        dangerouslySetInnerHTML={{ __html: seg.html }}
                      />
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* All comments in thread (no nesting - all at same level) */}
      <div>
        {comments.map((comment, idx) => {
          const isCommentAuthor = comment.author?.login === currentUser;
          const isEditing = editingCommentId === comment.databaseId;

          const handleStartEdit = () => {
            setEditText(comment.body);
            setEditingCommentId(comment.databaseId);
          };

          const handleCancelEdit = () => {
            setEditingCommentId(null);
            setEditText("");
          };

          const handleSave = async () => {
            if (!editText.trim() || !onEditComment) return;
            setSavingEdit(true);
            try {
              await onEditComment(comment.databaseId, editText.trim());
              setEditingCommentId(null);
            } finally {
              setSavingEdit(false);
            }
          };

          return (
            <div
              key={comment.id}
              className={cn(
                "p-4",
                idx < comments.length - 1 && "border-b border-border"
              )}
            >
              <div className="flex items-center gap-2 mb-2 text-sm">
                {comment.author && (
                  <>
                    <UserHoverCard login={comment.author.login}>
                      <img
                        src={comment.author.avatarUrl}
                        alt={comment.author.login}
                        className="w-6 h-6 rounded-full cursor-pointer"
                      />
                    </UserHoverCard>
                    <UserHoverCard login={comment.author.login}>
                      <span className="font-semibold hover:text-blue-400 hover:underline cursor-pointer">
                        {comment.author.login}
                      </span>
                    </UserHoverCard>
                  </>
                )}
                <a
                  href={`https://github.com/${owner}/${repo}/pull/${prNumber}#discussion_r${comment.databaseId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:underline"
                >
                  {getTimeAgo(new Date(comment.createdAt))}
                </a>
                {comment.updatedAt &&
                  comment.updatedAt !== comment.createdAt && (
                    <span className="text-muted-foreground">
                      · edited {getTimeAgo(new Date(comment.updatedAt))}
                    </span>
                  )}
              </div>
              <div className="mt-2">
                {isEditing ? (
                  <div className="space-y-3">
                    <MarkdownEditor
                      value={editText}
                      onChange={setEditText}
                      placeholder="Edit your comment..."
                      minHeight="60px"
                      autoFocus
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={handleCancelEdit}
                        className="px-3 py-1.5 text-sm rounded-md hover:bg-muted transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleSave}
                        disabled={!editText.trim() || savingEdit}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                      >
                        <Check className="w-3.5 h-3.5" />
                        Save
                      </button>
                    </div>
                  </div>
                ) : isMetadataComment ? (
                  <Markdown>{stripCommitMetadataPrefix(comment.body)}</Markdown>
                ) : (
                  <Markdown html={comment.bodyHTML}>{comment.body}</Markdown>
                )}
              </div>
              {/* Emoji reactions + actions */}
              <div className="mt-3 flex items-center gap-1">
                <EmojiReactions
                  reactions={reactions?.[comment.databaseId] || []}
                  onAddReaction={
                    canWrite && onAddReaction
                      ? (content) => onAddReaction(comment.databaseId, content)
                      : undefined
                  }
                  onRemoveReaction={
                    canWrite && onRemoveReaction
                      ? (reactionId) =>
                          onRemoveReaction(comment.databaseId, reactionId)
                      : undefined
                  }
                  currentUser={currentUser}
                />
                <div className="ml-auto flex items-center gap-3">
                  {canWrite && (
                    <button
                      onClick={() =>
                        handleQuoteReply(
                          isMetadataComment
                            ? stripCommitMetadataPrefix(comment.body)
                            : comment.body
                        )
                      }
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      title="Reply"
                    >
                      <Reply className="w-3 h-3" />
                      Reply
                    </button>
                  )}
                  {isCommentAuthor && onEditComment && !isEditing && (
                    <button
                      onClick={handleStartEdit}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      title="Edit"
                    >
                      <Pencil className="w-3 h-3" />
                      Edit
                    </button>
                  )}
                  {isCommentAuthor && onDeleteComment && !isEditing && (
                    <button
                      onClick={() => onDeleteComment(comment.databaseId)}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="w-3 h-3" />
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Reply box and actions */}
      {canWrite && (
        <div className="p-4 bg-card/30 border-t border-border">
          {showReplyBox ? (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                {currentUser && (
                  <img
                    src={`https://avatars.githubusercontent.com/${currentUser}`}
                    alt={currentUser}
                    className="w-6 h-6 rounded-full shrink-0 mt-1"
                  />
                )}
                <div className="flex-1">
                  <MarkdownEditor
                    value={replyText}
                    onChange={setReplyText}
                    onKeyDown={handleKeyDown}
                    placeholder="Write a reply..."
                    minHeight="80px"
                    autoFocus
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {canResolveThread && !thread.isResolved && (
                    <button
                      onClick={async () => {
                        if (!onResolve || resolving) return;
                        setResolving(true);
                        try {
                          await onResolve(thread.id);
                        } finally {
                          setResolving(false);
                        }
                      }}
                      disabled={resolving}
                      className="text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 rounded border border-border hover:bg-muted disabled:opacity-50"
                    >
                      {resolving ? "..." : "Resolve conversation"}
                    </button>
                  )}
                  {canResolveThread && thread.isResolved && (
                    <button
                      onClick={async () => {
                        if (!onUnresolve || resolving) return;
                        setResolving(true);
                        try {
                          await onUnresolve(thread.id);
                        } finally {
                          setResolving(false);
                        }
                      }}
                      disabled={resolving}
                      className="text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 rounded border border-border hover:bg-muted disabled:opacity-50"
                    >
                      {resolving ? "..." : "Unresolve"}
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setShowReplyBox(false);
                      setReplyText("");
                    }}
                    className="px-3 py-1.5 text-sm rounded-md hover:bg-muted transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSubmitReply}
                    disabled={!replyText.trim() || submitting}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50"
                  >
                    {submitting ? "Sending..." : "Reply"}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              {currentUser && (
                <img
                  src={`https://avatars.githubusercontent.com/${currentUser}`}
                  alt={currentUser}
                  className="w-6 h-6 rounded-full shrink-0"
                />
              )}
              <button
                onClick={() => setShowReplyBox(true)}
                className="flex-1 text-left px-3 py-2 text-sm text-muted-foreground bg-background border border-border rounded-md hover:border-blue-500/50 transition-colors"
              >
                Reply...
              </button>
              {canResolveThread &&
                (!thread.isResolved ? (
                  <button
                    onClick={async () => {
                      if (!onResolve || resolving) return;
                      setResolving(true);
                      try {
                        await onResolve(thread.id);
                      } finally {
                        setResolving(false);
                      }
                    }}
                    disabled={resolving}
                    className="text-xs px-3 py-2 rounded-md border border-border hover:bg-muted disabled:opacity-50 transition-colors"
                  >
                    {resolving ? "..." : "Resolve conversation"}
                  </button>
                ) : (
                  <button
                    onClick={async () => {
                      if (!onUnresolve || resolving) return;
                      setResolving(true);
                      try {
                        await onUnresolve(thread.id);
                      } finally {
                        setResolving(false);
                      }
                    }}
                    disabled={resolving}
                    className="text-xs px-3 py-2 rounded-md border border-border hover:bg-muted disabled:opacity-50 transition-colors"
                  >
                    {resolving ? "..." : "Unresolve"}
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Merge Section Component
// ============================================================================

function MergeSection({
  pr,
  checkStatus,
  checks,
  canMerge: canMergePR,
  canMergeRepo,
  merging,
  mergeMethod,
  showMergeOptions,
  mergeError,
  latestReviews,
  hasMergeQueue,
  inMergeQueue,
  dequeueing,
  onDequeue,
  onMerge,
  onSetMergeMethod,
  onToggleMergeOptions,
  onUpdateBranch,
  markingReady,
  onMarkReadyForReview,
  markingReadyError,
  workflowRunsAwaitingApproval,
  approvingWorkflows,
  onApproveWorkflows,
  canBypassBranchProtections,
}: {
  pr: {
    draft?: boolean;
    state: string;
    mergeable: boolean | null;
    mergeable_state?: string;
    requested_reviewers?: Array<{ login: string; avatar_url: string }> | null;
  };
  checkStatus: "success" | "failure" | "pending" | "action_required";
  checks: { checkRuns: CheckRun[]; status: CombinedStatus } | null;
  canMerge: boolean;
  canMergeRepo: boolean;
  merging: boolean;
  mergeMethod: "merge" | "squash" | "rebase";
  showMergeOptions: boolean;
  mergeError: string | null;
  latestReviews: Review[];
  hasMergeQueue: boolean;
  inMergeQueue: boolean;
  dequeueing: boolean;
  onDequeue: () => void;
  onMerge: () => void;
  onSetMergeMethod: (method: "merge" | "squash" | "rebase") => void;
  onToggleMergeOptions: () => void;
  onUpdateBranch: () => void;
  markingReady?: boolean;
  onMarkReadyForReview?: () => void;
  markingReadyError?: string | null;
  workflowRunsAwaitingApproval?: Array<{
    id: number;
    name: string;
    html_url: string;
  }>;
  approvingWorkflows?: boolean;
  onApproveWorkflows?: () => void;
  canBypassBranchProtections?: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropdownPosition, setDropdownPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
  });
  const [expandedSections, setExpandedSections] = useState<
    Record<string, boolean>
  >({});
  const [bypassRules, setBypassRules] = useState(false);
  const [updatingBranch, setUpdatingBranch] = useState(false);
  const [updateBranchError, setUpdateBranchError] = useState<string | null>(
    null
  );
  const [updateBranchSuccess, setUpdateBranchSuccess] = useState(false);

  const handleUpdateBranch = useCallback(async () => {
    setUpdatingBranch(true);
    setUpdateBranchError(null);
    setUpdateBranchSuccess(false);
    try {
      await onUpdateBranch();
      setUpdateBranchSuccess(true);
      // Clear success message after 3 seconds
      setTimeout(() => setUpdateBranchSuccess(false), 3000);
    } catch (error) {
      setUpdateBranchError(
        error instanceof Error ? error.message : "Failed to update branch"
      );
    } finally {
      setUpdatingBranch(false);
    }
  }, [onUpdateBranch]);

  const mergeDescriptions: Record<"merge" | "squash" | "rebase", string> = {
    merge:
      "All commits from this branch will be added to the base branch via a merge commit.",
    squash:
      "The commits will be squashed into a single commit in the base branch.",
    rebase: "The commits will be rebased and added to the base branch.",
  };

  const handleToggleDropdown = useCallback(() => {
    if (!showMergeOptions && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
    }
    onToggleMergeOptions();
  }, [showMergeOptions, onToggleMergeOptions]);

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  // Calculate checks info with detailed breakdown
  const totalChecks = checks
    ? checks.checkRuns.length + checks.status.statuses.length
    : 0;
  const successfulChecks = checks
    ? checks.checkRuns.filter((c) => c.conclusion === "success").length +
      checks.status.statuses.filter((s) => s.state === "success").length
    : 0;
  const failedChecks = checks
    ? checks.checkRuns.filter((c) => c.conclusion === "failure").length +
      checks.status.statuses.filter((s) => s.state === "failure").length
    : 0;
  const skippedChecks = checks
    ? checks.checkRuns.filter((c) => c.conclusion === "skipped").length
    : 0;
  const queuedChecks = checks
    ? checks.checkRuns.filter((c) => c.status === "queued").length +
      checks.status.statuses.filter((s) => s.state === "pending").length
    : 0;
  const inProgressChecks = checks
    ? checks.checkRuns.filter((c) => c.status === "in_progress").length
    : 0;
  const pendingChecks = queuedChecks + inProgressChecks;

  // Review info
  const pendingReviewers = pr.requested_reviewers?.length || 0;
  const approvalCount = latestReviews.filter(
    (r) => r.state === "APPROVED"
  ).length;
  const hasApproval = approvalCount > 0;
  const hasChangesRequested = latestReviews.some(
    (r) => r.state === "CHANGES_REQUESTED"
  );
  const changesRequestedCount = latestReviews.filter(
    (r) => r.state === "CHANGES_REQUESTED"
  ).length;

  // Status indicators
  const reviewStatus = hasChangesRequested
    ? "failure"
    : hasApproval
      ? "success"
      : pendingReviewers > 0
        ? "pending"
        : "success";
  const conflictStatus =
    pr.mergeable === false
      ? "failure"
      : pr.mergeable === null
        ? "pending"
        : "success";

  // Overall border color based on status
  const overallStatus =
    conflictStatus === "failure" ||
    checkStatus === "failure" ||
    reviewStatus === "failure"
      ? "failure"
      : conflictStatus === "pending" ||
          checkStatus === "pending" ||
          reviewStatus === "pending"
        ? "pending"
        : "success";

  return (
    <div
      className={cn(
        "border rounded-md overflow-hidden",
        overallStatus === "success"
          ? "border-green-600"
          : overallStatus === "failure"
            ? "border-red-500"
            : "border-yellow-500"
      )}
    >
      {/* Review Section */}
      <div className="border-b border-border">
        <button
          onClick={() => toggleSection("reviews")}
          className="w-full flex items-center gap-3 p-4 hover:bg-card/30 transition-colors"
        >
          {reviewStatus === "success" ? (
            <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" />
          ) : reviewStatus === "failure" ? (
            <XCircle className="w-5 h-5 text-red-500 shrink-0" />
          ) : (
            <Clock className="w-5 h-5 text-yellow-500 shrink-0" />
          )}
          <div className="flex-1 text-left">
            <p className="font-medium text-sm">Changes reviewed</p>
            <p className="text-xs text-muted-foreground">
              {hasChangesRequested
                ? `${changesRequestedCount} reviewer${changesRequestedCount !== 1 ? "s" : ""} requested changes`
                : hasApproval
                  ? `${approvalCount} approving review${approvalCount !== 1 ? "s" : ""} by reviewer${approvalCount !== 1 ? "s" : ""} with write access.`
                  : pendingReviewers > 0
                    ? "Review has been requested on this pull request."
                    : "No reviewers have been requested."}
            </p>
          </div>
          <ChevronDown
            className={cn(
              "w-4 h-4 text-muted-foreground transition-transform",
              expandedSections["reviews"] && "rotate-180"
            )}
          />
        </button>
        {expandedSections["reviews"] && (
          <div className="px-4 pb-4 pt-0 border-t border-border bg-card/20 space-y-1">
            {/* Approval count row */}
            {approvalCount > 0 && (
              <div className="flex items-center gap-2 py-2">
                <CheckCircle2 className="w-4 h-4 text-green-500" />
                <span className="text-sm">
                  {approvalCount} approval{approvalCount !== 1 ? "s" : ""}
                </span>
              </div>
            )}
            {/* Pending reviews row */}
            {pendingReviewers > 0 && (
              <div className="flex items-center gap-2 py-2">
                <User className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm">
                  {pendingReviewers} pending review
                  {pendingReviewers !== 1 ? "s" : ""}
                </span>
              </div>
            )}
            {/* Individual reviewers */}
            {latestReviews.length > 0 && (
              <TooltipProvider delayDuration={200}>
                <div className="pt-2 border-t border-border/50">
                  {latestReviews.map((review) => (
                    <div
                      key={review.id}
                      className="flex items-center gap-2 py-2"
                    >
                      <img
                        src={review.user?.avatar_url}
                        alt={review.user?.login}
                        className="w-5 h-5 rounded-full"
                      />
                      <span className="text-sm">
                        {review.user?.login ?? ""}
                      </span>
                      <ReviewStateIcon state={review.state} showTooltip />
                    </div>
                  ))}
                </div>
              </TooltipProvider>
            )}
          </div>
        )}
      </div>

      {/* Workflow Approval Section - shows when fork PR needs workflow approval */}
      {workflowRunsAwaitingApproval &&
        workflowRunsAwaitingApproval.length > 0 && (
          <div className="border-b border-border">
            <div className="flex items-center gap-3 p-4">
              <AlertCircle className="w-5 h-5 text-yellow-500 shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-sm">
                  {workflowRunsAwaitingApproval.length} workflow
                  {workflowRunsAwaitingApproval.length !== 1 ? "s" : ""}{" "}
                  awaiting approval
                </p>
                <p className="text-xs text-muted-foreground">
                  This workflow requires approval from a maintainer.{" "}
                  <a
                    href="https://docs.github.com/en/actions/managing-workflow-runs/approving-workflow-runs-from-public-forks"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline"
                  >
                    Learn more about approving workflows.
                  </a>
                </p>
              </div>
              {onApproveWorkflows && (
                <button
                  onClick={onApproveWorkflows}
                  disabled={approvingWorkflows}
                  className="px-3 py-1.5 text-sm font-medium border border-border rounded-md hover:bg-muted transition-colors disabled:opacity-50"
                >
                  {approvingWorkflows ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    "Approve workflows to run"
                  )}
                </button>
              )}
            </div>
          </div>
        )}

      {/* Checks Section */}
      <div className="border-b border-border">
        <button
          onClick={() => toggleSection("checks")}
          className="w-full flex items-center gap-3 p-4 hover:bg-card/30 transition-colors"
        >
          {checkStatus === "success" ? (
            <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" />
          ) : checkStatus === "failure" ? (
            <XCircle className="w-5 h-5 text-red-500 shrink-0" />
          ) : checkStatus === "action_required" ? (
            <AlertCircle className="w-5 h-5 text-yellow-500 shrink-0" />
          ) : (
            <Clock className="w-5 h-5 text-yellow-500 shrink-0" />
          )}
          <div className="flex-1 text-left">
            <p className="font-medium text-sm">
              {checkStatus === "success"
                ? "All checks have passed"
                : checkStatus === "failure"
                  ? "Some checks have failed"
                  : checkStatus === "action_required"
                    ? "Workflow approval required"
                    : "Some checks haven't completed yet"}
            </p>
            <p className="text-xs text-muted-foreground">
              {checkStatus === "action_required" && totalChecks === 0
                ? "Approve workflows to run checks"
                : [
                    queuedChecks > 0 && `${queuedChecks} queued`,
                    skippedChecks > 0 && `${skippedChecks} skipped`,
                    successfulChecks > 0 && `${successfulChecks} successful`,
                    failedChecks > 0 && `${failedChecks} failed`,
                    inProgressChecks > 0 && `${inProgressChecks} in progress`,
                  ]
                    .filter(Boolean)
                    .join(", ") +
                  " " +
                  (totalChecks === 1 ? "check" : "checks")}
            </p>
          </div>
          <ChevronDown
            className={cn(
              "w-4 h-4 text-muted-foreground transition-transform",
              expandedSections["checks"] && "rotate-180"
            )}
          />
        </button>
        {expandedSections["checks"] && checks && (
          <div className="px-4 pb-4 pt-0 border-t border-border bg-card/20 max-h-[300px] overflow-auto">
            {checks.checkRuns.map((check) => (
              <div key={check.id} className="flex items-center gap-2 py-2">
                {check.status === "queued" ? (
                  <div className="w-4 h-4 rounded-full border-2 border-yellow-500 shrink-0" />
                ) : check.status === "in_progress" ? (
                  <Loader2 className="w-4 h-4 text-yellow-500 shrink-0 animate-spin" />
                ) : check.conclusion === "success" ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                ) : check.conclusion === "failure" ? (
                  <XCircle className="w-4 h-4 text-red-500 shrink-0" />
                ) : check.conclusion === "skipped" ? (
                  <div className="w-4 h-4 rounded-full border-2 border-muted-foreground shrink-0 flex items-center justify-center">
                    <div className="w-2 h-0.5 bg-muted-foreground" />
                  </div>
                ) : (
                  <Clock className="w-4 h-4 text-yellow-500 shrink-0" />
                )}
                <span className="text-sm truncate flex-1">{check.name}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {check.status === "queued"
                    ? "Queued"
                    : check.status === "in_progress"
                      ? "In progress"
                      : check.conclusion === "skipped"
                        ? "Skipped"
                        : ""}
                </span>
                {check.html_url && (
                  <a
                    href={check.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:underline shrink-0"
                  >
                    Details
                  </a>
                )}
              </div>
            ))}
            {checks.status.statuses.map((status) => (
              <div key={status.id} className="flex items-center gap-2 py-2">
                {status.state === "success" ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                ) : status.state === "failure" || status.state === "error" ? (
                  <XCircle className="w-4 h-4 text-red-500 shrink-0" />
                ) : status.state === "pending" ? (
                  <div className="w-4 h-4 rounded-full border-2 border-yellow-500 shrink-0" />
                ) : (
                  <Clock className="w-4 h-4 text-yellow-500 shrink-0" />
                )}
                <span className="text-sm truncate flex-1">
                  {status.context}
                </span>
                {status.state === "pending" && (
                  <span className="text-xs text-muted-foreground shrink-0">
                    Pending
                  </span>
                )}
                {status.target_url && (
                  <a
                    href={status.target_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:underline shrink-0"
                  >
                    Details
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Conflicts Section */}
      <div className="border-b border-border">
        <div className="flex items-center gap-3 p-4">
          {conflictStatus === "success" ? (
            <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" />
          ) : conflictStatus === "failure" ? (
            <XCircle className="w-5 h-5 text-red-500 shrink-0" />
          ) : (
            <Clock className="w-5 h-5 text-yellow-500 shrink-0" />
          )}
          <div className="flex-1">
            <p className="font-medium text-sm">
              {conflictStatus === "success"
                ? "No conflicts with base branch"
                : conflictStatus === "failure"
                  ? "This branch has conflicts"
                  : "Checking for conflicts..."}
            </p>
            <p className="text-xs text-muted-foreground">
              {updateBranchSuccess ? (
                <span className="text-green-500">
                  Branch updated successfully!
                </span>
              ) : updateBranchError ? (
                <span className="text-red-500">{updateBranchError}</span>
              ) : conflictStatus === "success" ? (
                "Merging can be performed automatically."
              ) : conflictStatus === "failure" ? (
                "Conflicts must be resolved before merging."
              ) : (
                "Checking if this branch can be merged..."
              )}
            </p>
          </div>
          {/* Only show Update branch when the branch is behind the base */}
          {conflictStatus === "success" && pr.mergeable_state === "behind" && (
            <button
              onClick={handleUpdateBranch}
              disabled={updatingBranch}
              className="flex items-center gap-1 px-3 py-1.5 border border-border rounded-md hover:bg-muted transition-colors text-sm font-medium disabled:opacity-50"
            >
              {updatingBranch ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  Update branch
                  <ChevronDown className="w-4 h-4" />
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Draft section - show when PR is a draft */}
      {pr.draft && (
        <div className="p-4">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-full bg-muted text-muted-foreground">
              <GitPullRequest className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <p className="font-medium text-sm">
                This pull request is still a work in progress
              </p>
              <p className="text-xs text-muted-foreground">
                Draft pull requests cannot be merged.
              </p>
            </div>
            {canMergeRepo && onMarkReadyForReview && (
              <>
                <button
                  onClick={onMarkReadyForReview}
                  disabled={markingReady}
                  className="px-3 py-1.5 border border-border rounded-md hover:bg-muted transition-colors text-sm font-medium disabled:opacity-50"
                >
                  {markingReady ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    "Ready for review"
                  )}
                </button>
                {markingReadyError && (
                  <p className="text-sm text-destructive mt-1">
                    {markingReadyError}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Merge controls - only show when user can merge and PR is not a draft */}
      {canMergeRepo && !pr.draft && (
        <div className="p-4 space-y-3">
          {mergeError && (
            <p className="text-sm text-destructive">{mergeError}</p>
          )}

          {/* Bypass rules checkbox - only show when:
              1. User can bypass branch protections (viewerCanMergeAsAdmin)
              2. AND there are actually unmet requirements (something to bypass) */}
          {canBypassBranchProtections && overallStatus !== "success" && (
            <label className="flex items-start gap-2 cursor-pointer group">
              <Checkbox
                checked={bypassRules}
                onCheckedChange={(checked) => setBypassRules(checked === true)}
                className="mt-0.5"
              />
              <span className="text-sm text-yellow-500 group-hover:text-yellow-400">
                Merge without waiting for requirements to be met (bypass rules)
              </span>
            </label>
          )}

          {/* Merge button with dropdown (or Remove-from-queue button) */}
          <div className="flex items-center gap-0.5">
            {inMergeQueue ? (
              <button
                onClick={onDequeue}
                disabled={dequeueing}
                className="flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white transition-colors disabled:opacity-50"
                style={{ backgroundColor: "#9a6700" }}
              >
                {dequeueing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  "Remove from queue"
                )}
              </button>
            ) : (
              <>
                <div
                  className={cn(
                    "flex rounded-md transition-colors",
                    canMergePR || bypassRules
                      ? "bg-green-600 hover:bg-green-700"
                      : "bg-muted"
                  )}
                >
                  <button
                    onClick={onMerge}
                    disabled={merging || (!canMergePR && !bypassRules)}
                    className={cn(
                      "flex items-center justify-center gap-2 px-4 py-2 rounded-l-md text-sm font-medium transition-colors",
                      canMergePR || bypassRules
                        ? "text-white hover:bg-green-700"
                        : "text-muted-foreground cursor-not-allowed"
                    )}
                  >
                    {merging ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : hasMergeQueue ? (
                      "Add to merge queue"
                    ) : (
                      getMergeButtonText(mergeMethod)
                    )}
                  </button>
                  <button
                    ref={buttonRef}
                    onClick={handleToggleDropdown}
                    disabled={merging}
                    className={cn(
                      "px-3 py-2 rounded-r-md text-sm font-medium transition-colors border-l",
                      canMergePR || bypassRules
                        ? "text-white hover:bg-green-700 border-green-500"
                        : "text-muted-foreground cursor-not-allowed border-green-500/30"
                    )}
                  >
                    <ChevronDown
                      className={cn(
                        "w-4 h-4 transition-transform",
                        showMergeOptions && "rotate-180"
                      )}
                    />
                  </button>
                </div>
              </>
            )}

            {/* Dropdown menu */}
            {!inMergeQueue && showMergeOptions && (
              <>
                {/* Backdrop */}
                <div
                  className="fixed inset-0 z-[100]"
                  onClick={onToggleMergeOptions}
                />
                {/* Menu */}
                <div
                  className="fixed bg-card border border-border rounded-md shadow-xl z-[101] overflow-hidden"
                  style={{
                    top: dropdownPosition.top,
                    left: dropdownPosition.left,
                    width: Math.max(dropdownPosition.width, 280),
                  }}
                >
                  {(["squash", "merge", "rebase"] as const).map((method) => (
                    <button
                      key={method}
                      onClick={() => {
                        onSetMergeMethod(method);
                        onToggleMergeOptions();
                      }}
                      className={cn(
                        "w-full px-4 py-3 text-left hover:bg-muted transition-colors",
                        mergeMethod === method && "bg-muted/50"
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {mergeMethod === method ? (
                          <Check className="w-4 h-4 text-green-500" />
                        ) : (
                          <div className="w-4 h-4" />
                        )}
                        <span className="font-medium text-sm">
                          {getMergeButtonText(method)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground ml-6 mt-0.5">
                        {mergeDescriptions[method]}
                      </p>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Merge queue info */}
          {hasMergeQueue && (
            <p className="text-xs text-muted-foreground">
              This repository uses the{" "}
              <a
                href="https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline"
              >
                merge queue
              </a>{" "}
              for all merges into the main branch.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Commits Tab Component
// ============================================================================

function CommitsTab({
  commits,
  owner,
  repo,
}: {
  commits: PRCommit[];
  owner: string;
  repo: string;
}) {
  const store = usePRReviewStore();
  return (
    <div className="border border-border rounded-md overflow-hidden divide-y divide-border">
      {commits.map((commit) => (
        <div
          key={commit.sha}
          className="flex items-center gap-3 p-3 hover:bg-card/30 cursor-pointer"
          onClick={async () => {
            await store.setSelectedCommitSha(commit.sha);
            const { files } = store.getSnapshot();
            if (files.length > 0) {
              store.selectFile(files[0].filename);
            }
          }}
        >
          <img
            src={commit.author?.avatar_url || commit.committer?.avatar_url}
            alt={commit.commit.author?.name}
            className="w-6 h-6 rounded-full"
          />
          <div className="flex-1 min-w-0">
            <span className="text-sm font-medium truncate block">
              {commit.commit.message.split("\n")[0]}
            </span>
            <p className="text-xs text-muted-foreground">
              {commit.commit.author?.name} committed{" "}
              {commit.commit.author?.date &&
                getTimeAgo(new Date(commit.commit.author.date))}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {commit.parents && commit.parents.length > 1 ? (
              <GitMerge className="w-4 h-4 text-purple-500" />
            ) : (
              <GitCommit className="w-4 h-4 text-muted-foreground" />
            )}
            <a
              href={`https://github.com/${owner}/${repo}/commit/${commit.sha}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono text-muted-foreground hover:text-blue-400"
            >
              {commit.sha.slice(0, 7)}
            </a>
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(commit.sha);
              }}
              className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-muted"
              title="Copy commit SHA"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// Checks Tab Component
// ============================================================================

function ChecksTab({
  checks,
  lastUpdated,
  onRefresh,
  refreshing,
}: {
  checks: { checkRuns: CheckRun[]; status: CombinedStatus } | null;
  lastUpdated: Date | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  if (
    !checks ||
    (checks.checkRuns.length === 0 && checks.status.statuses.length === 0)
  ) {
    return (
      <div className="border border-border rounded-md p-8 text-center">
        <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-3" />
        <p className="text-muted-foreground">
          No checks configured for this repository
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Header with refresh */}
      <div className="flex items-center justify-end gap-2">
        {lastUpdated && (
          <span className="text-[10px] text-muted-foreground">
            Updated {getTimeAgo(lastUpdated)}
          </span>
        )}
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className={cn(
            "p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground",
            refreshing && "opacity-50"
          )}
          title="Refresh checks (auto-refreshes every 30s)"
        >
          <RefreshCw
            className={cn("w-3.5 h-3.5", refreshing && "animate-spin")}
          />
        </button>
      </div>

      {/* Checks list */}
      <div className="border border-border rounded-md overflow-hidden divide-y divide-border">
        {checks.checkRuns.map((check) => (
          <CheckRunItem key={check.id} check={check} />
        ))}
        {checks.status.statuses.map((status, idx) => (
          <StatusItem key={idx} status={status} />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Helper Components
// ============================================================================

function CheckRunItem({ check }: { check: CheckRun }) {
  const getIcon = () => {
    if (check.status !== "completed") {
      return <Clock className="w-4 h-4 text-yellow-500 animate-pulse" />;
    }
    switch (check.conclusion) {
      case "success":
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case "failure":
        return <XCircle className="w-4 h-4 text-red-500" />;
      default:
        return <MinusCircle className="w-4 h-4 text-muted-foreground" />;
    }
  };

  return (
    <div className="flex items-center gap-3 p-3 hover:bg-card/30">
      {getIcon()}
      <span className="flex-1 text-sm">{check.name}</span>
      {check.html_url && (
        <a
          href={check.html_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-400 hover:underline"
        >
          Details
        </a>
      )}
    </div>
  );
}

function StatusItem({
  status,
}: {
  status: {
    state: string;
    context: string;
    description: string | null;
    target_url: string | null;
  };
}) {
  const getIcon = () => {
    switch (status.state) {
      case "success":
        return <CheckCircle2 className="w-4 h-4 text-green-500" />;
      case "failure":
      case "error":
        return <XCircle className="w-4 h-4 text-red-500" />;
      default:
        return <Clock className="w-4 h-4 text-yellow-500 animate-pulse" />;
    }
  };

  return (
    <div className="flex items-center gap-3 p-3 hover:bg-card/30">
      {getIcon()}
      <div className="flex-1 min-w-0">
        <span className="text-sm">{status.context}</span>
        {status.description && (
          <p className="text-xs text-muted-foreground truncate">
            {status.description}
          </p>
        )}
      </div>
      {status.target_url && (
        <a
          href={status.target_url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-400 hover:underline"
        >
          Details
        </a>
      )}
    </div>
  );
}

function CheckStatusIcon({
  status,
  size = "md",
}: {
  status: "success" | "failure" | "pending" | "action_required";
  size?: "sm" | "md";
}) {
  const sizeClass = size === "sm" ? "w-4 h-4" : "w-5 h-5";

  switch (status) {
    case "success":
      return <CheckCircle2 className={cn(sizeClass, "text-green-500")} />;
    case "failure":
      return <XCircle className={cn(sizeClass, "text-red-500")} />;
    case "action_required":
      return <AlertCircle className={cn(sizeClass, "text-orange-500")} />;
    default:
      return <Clock className={cn(sizeClass, "text-yellow-500")} />;
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function calculateCheckStatus(
  checks: { checkRuns: CheckRun[]; status: CombinedStatus } | null,
  workflowRunsAwaitingApproval?: Array<{ id: number }>
): "success" | "failure" | "pending" | "action_required" {
  // If there are workflow runs awaiting approval
  if (workflowRunsAwaitingApproval && workflowRunsAwaitingApproval.length > 0) {
    // If no checks data, show action_required
    if (!checks) return "action_required";

    const allChecks = [
      ...checks.checkRuns.map((c) =>
        c.status === "completed" ? c.conclusion : "pending"
      ),
      ...checks.status.statuses.map((s) => s.state),
    ];

    // If no checks at all, show action_required
    if (allChecks.length === 0) return "action_required";

    // If there are checks, evaluate them first
    if (allChecks.some((c) => c === "failure" || c === "error"))
      return "failure";
    if (allChecks.some((c) => c === "pending" || c === null)) return "pending";

    // All checks passed but workflows still need approval
    return "action_required";
  }

  if (!checks) return "success";

  const allChecks = [
    ...checks.checkRuns.map((c) =>
      c.status === "completed" ? c.conclusion : "pending"
    ),
    ...checks.status.statuses.map((s) => s.state),
  ];

  if (allChecks.length === 0) return "success";
  if (allChecks.some((c) => c === "failure" || c === "error")) return "failure";
  if (allChecks.some((c) => c === "pending" || c === null)) return "pending";
  return "success";
}

function getLatestReviewsByUser(reviews: Review[]): Review[] {
  const byUser = new Map<string, Review>();
  const sorted = [...reviews]
    .filter((r) => r.submitted_at && r.user)
    .sort(
      (a, b) =>
        new Date(a.submitted_at!).getTime() -
        new Date(b.submitted_at!).getTime()
    );

  // Only include actual reviews (APPROVED or CHANGES_REQUESTED)
  // COMMENTED is not a review decision - it's just leaving comments
  for (const review of sorted) {
    if (
      (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") &&
      review.user
    ) {
      byUser.set(review.user.login, review);
    }
  }

  return [...byUser.values()];
}

interface PRData {
  draft?: boolean;
  state: string;
  mergeable: boolean | null;
}

function canMerge(
  pr: PRData,
  checkStatus: "success" | "failure" | "pending" | "action_required"
): boolean {
  if (pr.draft) return false;
  if (pr.state !== "open") return false;
  if (pr.mergeable === false) return false;
  return true;
}

function getMergeStatusText(
  pr: PRData,
  checkStatus: "success" | "failure" | "pending" | "action_required"
): string {
  if (pr.draft) return "This pull request is still a draft";
  if (pr.mergeable === false)
    return "This branch has conflicts that must be resolved";
  if (checkStatus === "failure") return "Some checks have failed";
  if (checkStatus === "pending") return "Some checks haven't completed yet";
  return "This branch has no conflicts with the base branch";
}

function getMergeButtonText(method: "merge" | "squash" | "rebase"): string {
  switch (method) {
    case "merge":
      return "Create a merge commit";
    case "squash":
      return "Squash and merge";
    case "rebase":
      return "Rebase and merge";
  }
}

// ============================================================================
// Commit Group Component - Compact commit display
// ============================================================================

type CommittedEvent = Extract<
  TimelineEvent,
  { sha: string; author: { date: string } }
>;

interface CommitGroupProps {
  commits: CommittedEvent[];
  prCommits: PRCommit[];
  owner: string;
  repo: string;
  onNavigate?: (sha: string) => void;
}

function CommitGroup({
  commits,
  prCommits,
  owner,
  repo,
  onNavigate,
}: CommitGroupProps) {
  if (commits.length === 0) return null;

  // Create a map from SHA to PRCommit for looking up GitHub usernames
  const prCommitMap = new Map(prCommits.map((c) => [c.sha, c]));

  // Get author info - prefer GitHub login over git commit name
  const getAuthorInfo = (
    commit: CommittedEvent
  ): { login?: string; name: string } => {
    const prCommit = prCommitMap.get(commit.sha);
    const login = prCommit?.author?.login;
    const name = login || commit.author.name || "Someone";
    return { login, name };
  };

  // Render author name with hover card if we have a GitHub login
  const renderAuthor = (commit: CommittedEvent) => {
    const { login, name } = getAuthorInfo(commit);
    if (login) {
      return (
        <UserHoverCard login={login}>
          <span className="font-medium text-foreground cursor-pointer hover:text-blue-400 hover:underline truncate">
            {name}
          </span>
        </UserHoverCard>
      );
    }
    return <span className="font-medium text-foreground truncate">{name}</span>;
  };

  const lastCommit = commits[commits.length - 1];
  const firstAuthorInfo = getAuthorInfo(commits[0]);

  return (
    <div>
      {/* Only show header if more than 1 commit */}
      {commits.length > 1 && (
        <div className="flex items-center gap-3 py-1.5 text-sm text-muted-foreground">
          <div className="relative z-10 p-1.5 rounded-full bg-background border border-border shrink-0">
            <GitCommit className="w-4 h-4" />
          </div>
          <span>
            {firstAuthorInfo.login ? (
              <UserHoverCard login={firstAuthorInfo.login}>
                <span className="font-medium text-foreground cursor-pointer hover:text-blue-400 hover:underline">
                  {firstAuthorInfo.name}
                </span>
              </UserHoverCard>
            ) : (
              <span className="font-medium text-foreground">
                {firstAuthorInfo.name}
              </span>
            )}{" "}
            added {commits.length} commits{" "}
            {getTimeAgo(new Date(lastCommit.author.date))}
          </span>
        </div>
      )}

      {/* Individual commits */}
      {commits.map((commit) => (
        <div
          key={commit.sha}
          className="flex items-center gap-3 py-1.5 text-sm text-muted-foreground"
        >
          <div className="relative z-10 p-1.5 rounded-full bg-background border border-border shrink-0">
            {commit.parents && commit.parents.length > 1 ? (
              <GitMerge className="w-4 h-4 text-purple-500" />
            ) : (
              <GitCommit className="w-4 h-4" />
            )}
          </div>
          <div className="flex-1 min-w-0 flex items-center gap-2">
            {renderAuthor(commit)}
            <a
              href={`#commit=${commit.sha}`}
              onClick={
                onNavigate
                  ? (e) => {
                      e.preventDefault();
                      onNavigate(commit.sha);
                    }
                  : undefined
              }
              className="flex-1 min-w-0 truncate hover:text-blue-400"
              title={commit.message}
            >
              {commit.message.split("\n")[0]}
            </a>
            <a
              href={commit.html_url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs hover:text-blue-400 shrink-0"
            >
              {commit.sha.slice(0, 7)}
            </a>
            <span className="shrink-0">
              {getTimeAgo(new Date(commit.author.date))}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function CommitRow({
  commit,
  owner,
  repo,
  versionSha,
  onNavigate,
}: {
  commit: PRCommit;
  owner: string;
  repo: string;
  versionSha?: string;
  onNavigate?: (sha: string, versionSha?: string) => void;
}) {
  return (
    <div className="text-xs text-muted-foreground flex items-center gap-2">
      {commit.parents && commit.parents.length > 1 ? (
        <GitMerge className="w-3 h-3 shrink-0 text-purple-500" />
      ) : (
        <GitCommit className="w-3 h-3 shrink-0" />
      )}
      <a
        href={
          versionSha
            ? `#view=${versionSha}&commit=${commit.sha}`
            : `#commit=${commit.sha}`
        }
        onClick={
          onNavigate
            ? (e) => {
                e.preventDefault();
                onNavigate(commit.sha, versionSha);
              }
            : undefined
        }
        className="truncate hover:text-blue-400"
      >
        {commit.commit.message.split("\n")[0]}
      </a>
      <a
        href={`https://github.com/${owner}/${repo}/commit/${commit.sha}`}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-muted-foreground hover:text-blue-400 shrink-0"
      >
        {commit.sha.slice(0, 7)}
      </a>
    </div>
  );
}

function CommitList({
  commits,
  owner,
  repo,
  versionSha,
  onNavigate,
}: {
  commits: PRCommit[];
  owner: string;
  repo: string;
  versionSha?: string;
  onNavigate?: (sha: string, versionSha?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (commits.length === 0) return null;
  const showEllipsis = !expanded && commits.length > 3;

  return (
    <div className="ml-9 pl-4 border-l-2 border-border/30 space-y-1 py-1">
      {showEllipsis ? (
        <>
          <CommitRow
            commit={commits[0]}
            owner={owner}
            repo={repo}
            versionSha={versionSha}
            onNavigate={onNavigate}
          />
          <button
            onClick={() => setExpanded(true)}
            className="w-full text-left text-xs text-muted-foreground hover:text-blue-400 cursor-pointer pl-5"
          >
            {commits.length - 2} more commits...
          </button>
          <CommitRow
            commit={commits[commits.length - 1]}
            owner={owner}
            repo={repo}
            versionSha={versionSha}
            onNavigate={onNavigate}
          />
        </>
      ) : (
        commits.map((c) => (
          <CommitRow
            key={c.sha}
            commit={c}
            owner={owner}
            repo={repo}
            versionSha={versionSha}
            onNavigate={onNavigate}
          />
        ))
      )}
    </div>
  );
}

function ChecksIcon({
  sha,
  onNavigate,
}: {
  sha: string;
  onNavigate: (sha: string) => void;
}) {
  const store = usePRReviewStore();
  const [status, setStatus] = useState<
    "success" | "failure" | "pending" | null
  >(null);

  useEffect(() => {
    store.getChecksStatus(sha).then(setStatus);
  }, [sha, store]);

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onNavigate(sha);
      }}
      className="ml-1 align-middle inline-flex hover:opacity-80 transition-opacity cursor-pointer"
      title="View checks"
    >
      {status === null ? (
        <Loader2 className="w-3 h-3 text-muted-foreground animate-spin" />
      ) : status === "success" ? (
        <CheckCircle2 className="w-3 h-3 text-green-500" />
      ) : status === "failure" ? (
        <XCircle className="w-3 h-3 text-red-500" />
      ) : (
        <Clock className="w-3 h-3 text-yellow-500" />
      )}
    </button>
  );
}

// ============================================================================
// Timeline Item Component - Compact event display
// ============================================================================

interface TimelineItemProps {
  event: TimelineEvent;
  pr?: PullRequest;
  pushVersions?: PushVersion[];
  versionDiffCounts?: Record<string, number>;
  versionRebaseInfo?: Record<
    string,
    { rebased: boolean; fromBase: string; toBase: string }
  >;
  onNavigateChecks?: (sha: string) => void;
}

function TimelineItem({
  event,
  pr,
  pushVersions,
  versionDiffCounts,
  versionRebaseInfo,
  onNavigateChecks,
}: TimelineItemProps) {
  const store = usePRReviewStore();
  // Commits are handled by CommitGroup
  if ("sha" in event && "author" in event) return null;

  // Skip events that shouldn't be shown
  if (!("event" in event) || !event.event) return null;
  const skipEvents = ["commented", "reviewed", "line-commented"];
  if (skipEvents.includes(event.event)) return null;

  // Extract actor (not all event types have actor)
  const actor =
    "actor" in event
      ? (event.actor as { login: string; avatar_url: string })
      : undefined;
  const eventType = event.event;

  const getEventInfo = (): {
    icon: React.ReactNode;
    text: React.ReactNode;
    color: string;
  } | null => {
    switch (eventType) {
      case "review_requested": {
        const requested = event as {
          requested_reviewer?: { login: string };
          requested_team?: { name?: string; slug?: string };
        };
        return {
          icon: <Eye className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              requested a review from{" "}
              {requested.requested_reviewer?.login && (
                <UserHoverCard login={requested.requested_reviewer.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {requested.requested_reviewer.login}
                  </span>
                </UserHoverCard>
              )}
              {requested.requested_team?.name && (
                <span className="font-medium">
                  {requested.requested_team.name}
                </span>
              )}
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "review_request_removed": {
        const removed = event as {
          requested_reviewer?: { login: string };
          requested_team?: { name?: string; slug?: string };
        };
        return {
          icon: <Eye className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              removed the request for review from{" "}
              {removed.requested_reviewer?.login && (
                <UserHoverCard login={removed.requested_reviewer.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {removed.requested_reviewer.login}
                  </span>
                </UserHoverCard>
              )}
              {removed.requested_team?.name && (
                <span className="font-medium">
                  {removed.requested_team.name}
                </span>
              )}
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "assigned": {
        const assigned = event as { assignee?: { login: string } };
        const isSelf = actor?.login === assigned.assignee?.login;
        return {
          icon: <UserPlus className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}
              {isSelf ? (
                " self-assigned this"
              ) : (
                <>
                  {" "}
                  assigned{" "}
                  {assigned.assignee?.login && (
                    <UserHoverCard login={assigned.assignee.login}>
                      <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                        {assigned.assignee.login}
                      </span>
                    </UserHoverCard>
                  )}
                </>
              )}
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "unassigned": {
        const unassigned = event as { assignee?: { login: string } };
        const isSelf = actor?.login === unassigned.assignee?.login;
        return {
          icon: <UserMinus className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}
              {isSelf ? (
                " removed their assignment"
              ) : (
                <>
                  {" "}
                  unassigned{" "}
                  {unassigned.assignee?.login && (
                    <UserHoverCard login={unassigned.assignee.login}>
                      <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                        {unassigned.assignee.login}
                      </span>
                    </UserHoverCard>
                  )}
                </>
              )}
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "labeled": {
        const labeled = event as { label?: { name: string; color: string } };
        return {
          icon: <Tag className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              added the{" "}
              <span
                className="px-2 py-0.5 text-xs font-medium rounded-full"
                style={{
                  backgroundColor: `#${labeled.label?.color}20`,
                  color: `#${labeled.label?.color}`,
                  border: `1px solid #${labeled.label?.color}40`,
                }}
              >
                {labeled.label?.name}
              </span>{" "}
              label
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "unlabeled": {
        const unlabeled = event as { label?: { name: string; color: string } };
        return {
          icon: <Tag className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              removed the{" "}
              <span
                className="px-2 py-0.5 text-xs font-medium rounded-full"
                style={{
                  backgroundColor: `#${unlabeled.label?.color}20`,
                  color: `#${unlabeled.label?.color}`,
                  border: `1px solid #${unlabeled.label?.color}40`,
                }}
              >
                {unlabeled.label?.name}
              </span>{" "}
              label
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "milestoned": {
        const milestoned = event as { milestone?: { title: string } };
        return {
          icon: <Milestone className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              added this to the{" "}
              <span className="font-medium">{milestoned.milestone?.title}</span>{" "}
              milestone
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "demilestoned": {
        const demilestoned = event as { milestone?: { title: string } };
        return {
          icon: <Milestone className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              removed this from the{" "}
              <span className="font-medium">
                {demilestoned.milestone?.title}
              </span>{" "}
              milestone
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "renamed": {
        const renamed = event as { rename?: { from: string; to: string } };
        return {
          icon: <FileEdit className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              changed the title from{" "}
              <del className="text-muted-foreground">
                {renamed.rename?.from}
              </del>{" "}
              to <span className="font-medium">{renamed.rename?.to}</span>
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "locked": {
        return {
          icon: <Lock className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              locked this conversation
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "unlocked": {
        return {
          icon: <Unlock className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              unlocked this conversation
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "head_ref_deleted": {
        return {
          icon: <GitBranch className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              deleted the head branch
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "head_ref_restored": {
        return {
          icon: <GitBranch className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              restored the head branch
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "head_ref_force_pushed": {
        // Timeline API only provides commit_id (the "to" SHA), no "before" SHA
        const forcePush = event as { commit_id?: string };
        const commitUrl =
          forcePush.commit_id && pr
            ? `https://github.com/${pr.base?.repo?.owner?.login || pr.user?.login}/${pr.base?.repo?.name || pr.head?.repo?.name}/commit/${forcePush.commit_id}`
            : undefined;
        const toVersion = pushVersions?.find(
          (v) => v.sha === forcePush.commit_id
        );
        const fromVersion =
          toVersion && pushVersions
            ? pushVersions.find((v) => v.version === toVersion.version - 1)
            : undefined;
        const diffKey =
          fromVersion &&
          toVersion &&
          `${fromVersion.version}-${toVersion.version}`;
        const diffCount = diffKey ? versionDiffCounts?.[diffKey] : undefined;
        const diffSummary =
          diffCount !== undefined
            ? diffCount === 0
              ? "no change"
              : `${diffCount} file${diffCount !== 1 ? "s" : ""} modified`
            : null;
        return {
          icon: <GitBranch className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              force-pushed
              {diffKey &&
                versionRebaseInfo?.[diffKey]?.rebased &&
                forcePush.commit_id && (
                  <span className="font-medium">
                    {" "}
                    (rebased onto{" "}
                    <a
                      href={commitUrl!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-1 py-0.5 bg-muted rounded text-xs font-mono hover:text-blue-400 hover:underline"
                    >
                      {forcePush.commit_id.slice(0, 7)}
                    </a>
                    )
                  </span>
                )}{" "}
              the{" "}
              <code className="px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">
                {pr?.head?.ref || "branch"}
              </code>{" "}
              branch{" "}
              {toVersion && fromVersion && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    await store.setCompareToSha(fromVersion.sha);
                    await store.setSelectedHeadSha(toVersion.sha);
                    const { files } = store.getSnapshot();
                    if (files.length > 0) {
                      store.selectFile(files[0].filename);
                    }
                  }}
                  className="text-muted-foreground hover:text-blue-400 hover:underline cursor-pointer transition-colors"
                >
                  (v{fromVersion.version} → v{toVersion.version}
                  {diffSummary !== null ? `, ${diffSummary}` : ""})
                </button>
              )}
              {forcePush.commit_id && (
                <ChecksIcon
                  sha={forcePush.commit_id}
                  onNavigate={onNavigateChecks!}
                />
              )}
            </span>
          ),
          color: "text-amber-400",
        };
      }

      case "head_ref_normal_pushed": {
        const pushEvent = event as TimelineEvent & {
          from_sha?: string;
          from_version?: number;
          to_version?: number;
        };
        const toVersion =
          pushEvent.to_version !== undefined &&
          pushVersions?.find((v) => v.version === pushEvent.to_version);
        const fromVersion =
          pushEvent.from_version !== undefined &&
          pushVersions?.find((v) => v.version === pushEvent.from_version);
        const diffKey =
          fromVersion &&
          toVersion &&
          `${fromVersion.version}-${toVersion.version}`;
        const diffCount = diffKey ? versionDiffCounts?.[diffKey] : undefined;
        const diffSummary =
          diffCount !== undefined
            ? diffCount === 0
              ? "no change"
              : `${diffCount} file${diffCount !== 1 ? "s" : ""} modified`
            : null;
        return {
          icon: <GitBranch className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              pushed the{" "}
              <code className="px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">
                {pr?.head?.ref || "branch"}
              </code>{" "}
              branch{" "}
              {toVersion && fromVersion && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    await store.setCompareToSha(fromVersion.sha);
                    await store.setSelectedHeadSha(toVersion.sha);
                    const { files } = store.getSnapshot();
                    if (files.length > 0) {
                      store.selectFile(files[0].filename);
                    }
                  }}
                  className="text-muted-foreground hover:text-blue-400 hover:underline cursor-pointer transition-colors"
                >
                  (v{fromVersion.version} → v{toVersion.version}
                  {diffSummary !== null ? `, ${diffSummary}` : ""})
                </button>
              )}
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "opened": {
        const firstVersion = pushVersions?.[0];
        return {
          icon: <GitPullRequest className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              opened the PR{" "}
              {firstVersion && (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    await store.setSelectedHeadSha(firstVersion.sha);
                    const { files } = store.getSnapshot();
                    if (files.length > 0) {
                      store.selectFile(files[0].filename);
                    }
                  }}
                  className="text-muted-foreground hover:text-blue-400 hover:underline cursor-pointer transition-colors"
                >
                  (v{firstVersion.version})
                </button>
              )}
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "merged": {
        const merged = event as { commit_id?: string };
        return {
          icon: <GitMerge className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              merged commit{" "}
              <code className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">
                {merged.commit_id?.slice(0, 7) ||
                  pr?.merge_commit_sha?.slice(0, 7)}
              </code>{" "}
              into{" "}
              <code className="px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded">
                {pr?.base?.ref || "main"}
              </code>
            </span>
          ),
          color: "text-purple-400",
        };
      }

      case "closed": {
        return {
          icon: <GitPullRequest className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              closed this pull request
            </span>
          ),
          color: "text-red-400",
        };
      }

      case "reopened": {
        return {
          icon: <GitPullRequest className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              reopened this pull request
            </span>
          ),
          color: "text-green-400",
        };
      }

      case "ready_for_review": {
        return {
          icon: <GitPullRequest className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              marked this pull request as ready for review
            </span>
          ),
          color: "text-green-400",
        };
      }

      case "convert_to_draft": {
        return {
          icon: <GitPullRequest className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              converted this pull request to draft
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "cross-referenced": {
        const crossRef = event as {
          source?: {
            issue?: {
              number: number;
              title: string;
              repository?: { full_name: string };
              pull_request?: object;
            };
          };
        };
        const fullName = crossRef.source?.issue?.repository?.full_name;
        const issueNumber = crossRef.source?.issue?.number;
        return {
          icon: <Link className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              mentioned this in{" "}
              {fullName && issueNumber ? (
                crossRef.source?.issue?.pull_request ? (
                  <a
                    href={`/${fullName}/pull/${issueNumber}`}
                    className="font-medium hover:text-blue-400 hover:underline"
                  >
                    {fullName}#{issueNumber}
                  </a>
                ) : (
                  <a
                    href={`https://github.com/${fullName}/issues/${issueNumber}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium hover:text-blue-400 hover:underline"
                  >
                    {fullName}#{issueNumber}
                  </a>
                )
              ) : (
                <span className="font-medium">
                  {fullName}#{issueNumber}
                </span>
              )}
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      case "comment_deleted": {
        return {
          icon: <X className="w-4 h-4" />,
          text: (
            <span>
              {actor?.login && (
                <UserHoverCard login={actor.login}>
                  <span className="font-medium cursor-pointer hover:text-blue-400 hover:underline">
                    {actor.login}
                  </span>
                </UserHoverCard>
              )}{" "}
              deleted a comment
            </span>
          ),
          color: "text-muted-foreground",
        };
      }

      default:
        return null;
    }
  };

  const eventInfo = getEventInfo();
  if (!eventInfo) return null;

  const displayDate = "created_at" in event ? event.created_at : undefined;

  return (
    <div className="flex items-center gap-3 py-1.5 text-sm text-muted-foreground">
      <div
        className={cn(
          "relative z-10 p-1.5 rounded-full bg-background border border-border shrink-0",
          eventInfo.color
        )}
      >
        {eventInfo.icon}
      </div>
      <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
        {eventInfo.text}
        {displayDate && (
          <span title={formatDateTime(new Date(displayDate))}>
            {getTimeAgo(new Date(displayDate))}
          </span>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Skeleton Components
// ============================================================================

function PROverviewSkeleton() {
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
            <CommentBoxSkeleton isLarge />

            {/* Timeline items skeleton */}
            {Array.from({ length: 3 }).map((_, i) => (
              <CommentBoxSkeleton key={i} />
            ))}

            {/* Merge section skeleton */}
            <div className="border border-border rounded-md overflow-hidden">
              {Array.from({ length: 3 }).map((_, i) => (
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
              <div className="p-4 space-y-3">
                <Skeleton className="h-10 w-full" />
              </div>
            </div>

            {/* Add comment skeleton */}
            <div className="flex gap-3">
              <Skeleton className="w-10 h-10 rounded-full shrink-0" />
              <div className="flex-1 flex flex-col gap-2">
                <Skeleton className="h-32 w-full rounded-md" />
                <div className="flex justify-end">
                  <Skeleton className="h-8 w-24" />
                </div>
              </div>
            </div>
          </div>

          {/* Right Column - Sidebar skeleton */}
          <div className="w-[296px] shrink-0 space-y-4">
            <SidebarSectionSkeleton title="Reviewers" itemCount={2} />
            <SidebarSectionSkeleton title="Assignees" itemCount={1} />
            <SidebarSectionSkeleton title="Labels" itemCount={3} hasLabels />
            <SidebarSectionSkeleton
              title="Participants"
              itemCount={4}
              hasAvatars
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function CommentBoxSkeleton({ isLarge }: { isLarge?: boolean }) {
  return (
    <div className="border border-border rounded-md overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-card/50">
        <Skeleton className="w-5 h-5 rounded-full" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-20" />
      </div>
      {/* Body */}
      <div className="p-4 space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-[90%]" />
        {isLarge && (
          <>
            <Skeleton className="h-4 w-[75%]" />
            <Skeleton className="h-4 w-[85%]" />
            <Skeleton className="h-4 w-[60%]" />
          </>
        )}
      </div>
      {/* Reactions */}
      <div className="px-4 py-2 border-t border-border flex gap-2">
        <Skeleton className="h-6 w-10 rounded-full" />
        <Skeleton className="h-6 w-10 rounded-full" />
      </div>
    </div>
  );
}

function SidebarSectionSkeleton({
  title,
  itemCount = 2,
  hasLabels,
  hasAvatars,
}: {
  title: string;
  itemCount?: number;
  hasLabels?: boolean;
  hasAvatars?: boolean;
}) {
  return (
    <div className="pb-3 border-b border-border">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-muted-foreground">
          {title}
        </span>
        <Skeleton className="w-4 h-4" />
      </div>
      {hasLabels ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          {Array.from({ length: itemCount }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-16 rounded-full" />
          ))}
        </div>
      ) : hasAvatars ? (
        <div className="flex items-center gap-1">
          {Array.from({ length: itemCount }).map((_, i) => (
            <Skeleton key={i} className="w-6 h-6 rounded-full" />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {Array.from({ length: itemCount }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton className="w-5 h-5 rounded-full" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
