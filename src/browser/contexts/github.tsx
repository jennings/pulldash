import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { Octokit } from "@octokit/core";
import type { components } from "@octokit/openapi-types";
import { useAuth } from "./auth";
import { setOctokit } from "../lib/github-client";
import { queryClient } from "../lib/query-client";
import { queries } from "../lib/queries";

export type UserTeam = { org: string; slug: string };
let userTeamsCache: UserTeam[] | null = null;

export function getCachedTeams(): UserTeam[] {
  return userTeamsCache ?? [];
}

// Re-export types
// Extended PullRequest with body_html from GitHub's HTML media type
export type PullRequest = components["schemas"]["pull-request"] & {
  body_html?: string;
};
export type PullRequestFile = components["schemas"]["diff-entry"];
// Extended ReviewComment with body_html from GitHub's HTML media type
export type ReviewComment =
  components["schemas"]["pull-request-review-comment"] & {
    body_html?: string;
    outdated?: boolean;
    is_resolved?: boolean;
    pull_request_review_thread_id?: string;
  };
// Extended Review with body_html from GitHub's HTML media type
export type Review = components["schemas"]["pull-request-review"] & {
  body_html?: string;
  reactions?: components["schemas"]["reaction"][];
};
export type CheckRun = components["schemas"]["check-run"];
export type CombinedStatus = components["schemas"]["combined-commit-status"];
// Extended IssueComment with body_html from GitHub's HTML media type
export type IssueComment = components["schemas"]["issue-comment"] & {
  body_html?: string;
};
export type PRCommit = components["schemas"]["commit"];
export type Collaborator = components["schemas"]["collaborator"];
export type Reaction = components["schemas"]["reaction"];
export type ReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "hooray"
  | "confused"
  | "heart"
  | "rocket"
  | "eyes";
export type TimelineEvent = components["schemas"]["timeline-issue-events"];
export type UserProfile = components["schemas"]["public-user"];

// ============================================================================
// Types
// ============================================================================

export interface PRSearchResult {
  id: number;
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  draft: boolean;
  state: string;
  repository_url: string;
  user: {
    login: string;
    avatar_url: string;
  } | null;
  labels: Array<{
    name: string;
    color: string;
  }>;
  pull_request?: {
    merged_at: string | null;
  };
  // Enrichment data
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  lastCommitAt?: string | null;
  viewerLastReviewAt?: string | null;
  hasNewChanges?: boolean;
  isReadByViewer?: boolean;
  hasNewContent?: boolean;
  // CI status
  ciStatus?: "pending" | "success" | "failure" | "none" | "action_required";
  ciSummary?: string; // e.g. "2/3 checks passed" or "Build failed"
  ciChecks?: Array<{
    name: string;
    state: "pending" | "success" | "failure" | "skipped";
  }>;
  // Review status
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  latestReviews?: Array<{
    login: string;
    avatarUrl: string;
    state: "APPROVED" | "CHANGES_REQUESTED";
  }>;
  // Whether this PR is currently sitting in the repo's merge queue
  inMergeQueue?: boolean;
}

export interface WorkflowRunAwaitingApproval {
  id: number;
  name: string;
  html_url: string;
}

export interface PushVersion {
  version: number;
  sha: string;
  pushedAt: string;
  /** For versions created by a force push, the SHA of the branch HEAD before
   *  the force push (from HeadRefForcePushedEvent.beforeCommit). */
  beforeSha?: string;
}

export function groupCommitsIntoVersions(
  commits: PRCommit[],
  maxGapMinutes = 2
): PushVersion[] {
  if (commits.length === 0) return [];

  const versions: PushVersion[] = [];
  let groupStart = 0;

  for (let i = 1; i < commits.length; i++) {
    const prevDate = new Date(
      commits[i - 1].commit.committer?.date ??
        commits[i - 1].commit.author?.date ??
        ""
    );
    const currDate = new Date(
      commits[i].commit.committer?.date ?? commits[i].commit.author?.date ?? ""
    );
    const gapMs = currDate.getTime() - prevDate.getTime();

    if (gapMs > maxGapMinutes * 60 * 1000) {
      versions.push({
        version: versions.length + 1,
        sha: commits[i - 1].sha,
        pushedAt:
          commits[i - 1].commit.committer?.date ??
          commits[i - 1].commit.author?.date ??
          "",
      });
      groupStart = i;
    }
  }

  // Last group — includes commits[groupStart..end]
  const last = commits[commits.length - 1];
  versions.push({
    version: versions.length + 1,
    sha: last.sha,
    pushedAt: last.commit.committer?.date ?? last.commit.author?.date ?? "",
  });

  return versions;
}

export interface CheckStatus {
  checks: "pending" | "success" | "failure" | "none" | "action_required";
  state: "open" | "closed" | "merged" | "draft";
  mergeable: boolean | null;
  workflowRunsAwaitingApproval?: WorkflowRunAwaitingApproval[];
}

export interface PREnrichment {
  changedFiles: number;
  additions: number;
  deletions: number;
  updatedAt: string;
  isReadByViewer: boolean;
  lastCommitAt: string | null;
  viewerLastReviewAt: string | null;
  hasNewChanges: boolean;
  ciStatus: "pending" | "success" | "failure" | "none" | "action_required";
  ciSummary: string;
  ciChecks: Array<{
    name: string;
    state: "pending" | "success" | "failure" | "skipped";
  }>;
  // Review status
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  latestReviews: Array<{
    login: string;
    avatarUrl: string;
    state: "APPROVED" | "CHANGES_REQUESTED";
  }>;
  inMergeQueue: boolean;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy: { login: string; avatarUrl: string } | null;
  // The review this thread belongs to (from first comment)
  pullRequestReview: {
    databaseId: number;
    author: { login: string; avatarUrl: string } | null;
  } | null;
  comments: {
    nodes: Array<{
      id: string;
      databaseId: number;
      body: string;
      /** Pre-rendered HTML with signed attachment URLs from GitHub's GraphQL API */
      bodyHTML?: string;
      path: string;
      line: number | null;
      originalLine: number | null;
      startLine: number | null;
      diffHunk: string | null;
      author: { login: string; avatarUrl: string } | null;
      createdAt: string;
      updatedAt: string;
      replyTo: { databaseId: number } | null;
    }>;
  };
}

export interface PendingReview {
  id: string;
  databaseId: number;
  viewerDidAuthor: boolean;
  comments: {
    nodes: Array<{
      id: string;
      databaseId: number;
      body: string;
      path: string;
      line: number;
      startLine: number | null;
    }>;
  };
}

// ============================================================================
// GraphQL Batcher - Combines multiple queries within a time window
// ============================================================================

interface BatchedQuery {
  query: string;
  variables: Record<string, unknown>;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}

class GraphQLBatcher {
  private queue: BatchedQuery[] = [];
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private octokit: Octokit;
  private batchWindowMs: number;

  constructor(octokit: Octokit, batchWindowMs = 5) {
    this.octokit = octokit;
    this.batchWindowMs = batchWindowMs; // 5ms batch window for near-instant batching
  }

  updateOctokit(octokit: Octokit) {
    this.octokit = octokit;
  }

  async query<T>(
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        query,
        variables,
        resolve: resolve as (data: unknown) => void,
        reject,
      });
      this.scheduleBatch();
    });
  }

  private scheduleBatch() {
    if (this.timeout) return;
    this.timeout = setTimeout(() => this.flush(), this.batchWindowMs);
  }

  private async flush() {
    this.timeout = null;
    const batch = this.queue.splice(0);
    if (batch.length === 0) return;

    // Execute all queries in parallel (GitHub doesn't support query batching in a single request)
    await Promise.all(
      batch.map(async ({ query, variables, resolve, reject }) => {
        try {
          const result = await this.octokit.graphql(query, variables);
          resolve(result);
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "errors" in error &&
            Array.isArray((error as Record<string, unknown>).errors)
          ) {
            const oauthError = (
              error as { errors: Array<{ message: string }> }
            ).errors.find((e) =>
              e.message?.includes("OAuth App access restrictions")
            );
            if (oauthError) {
              const match = oauthError.message.match(/`([^`]+)`/);
              const org = match ? match[1] : "this organization";
              reject(
                new Error(
                  `Blocked by ${org}'s OAuth App access restrictions. ` +
                    `Visit https://docs.github.com/articles/restricting-access-to-your-organization-s-data/ to learn how to grant access.`
                )
              );
              return;
            }
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })
    );
  }
}

// ============================================================================
// State Types
// ============================================================================

interface PRCheckState {
  status: CheckStatus | null;
  loading: boolean;
  lastFetchedAt: number | null;
}

export interface CurrentUserData {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
  html_url: string;
  bio: string | null;
  company: string | null;
  location: string | null;
}

interface GitHubState {
  ready: boolean;
  error: string | null;
  prChecks: Map<string, PRCheckState>;
}

type Listener = () => void;

// ============================================================================
// GitHub Store - Combines API client + state management
// ============================================================================

function createGitHubStore() {
  let state: GitHubState = {
    ready: false,
    error: null,
    prChecks: new Map(),
  };

  const listeners = new Set<Listener>();
  let octokit: Octokit | null = null;
  let batcher: GraphQLBatcher | null = null;
  let onUnauthorized: (() => void) | null = null;
  let onRateLimited: (() => void) | null = null;

  function setOnUnauthorized(callback: () => void) {
    onUnauthorized = callback;
  }

  function setOnRateLimited(callback: () => void) {
    onRateLimited = callback;
  }

  // Helper to wrap octokit with error hooks
  function wrapOctokitWithHooks(octokitInstance: Octokit) {
    octokitInstance.hook.wrap("request", async (request, options) => {
      try {
        return await request(options);
      } catch (error) {
        if (error && typeof error === "object" && "status" in error) {
          if (error.status === 401) {
            console.warn(
              "[GitHub] Received 401 Unauthorized - token may be revoked"
            );
            onUnauthorized?.();
          } else if (
            error.status === 403 &&
            "response" in error &&
            error.response &&
            typeof error.response === "object" &&
            "headers" in error.response
          ) {
            // Check for rate limit
            const headers = (
              error.response as { headers: Record<string, string> }
            ).headers;
            const remaining = headers["x-ratelimit-remaining"];
            if (remaining === "0") {
              console.warn("[GitHub] Rate limit exceeded");
              onRateLimited?.();
            }
          }
        }
        throw error;
      }
    });
  }

  function getState() {
    return state;
  }

  function setState(
    partial: Partial<GitHubState> | ((s: GitHubState) => Partial<GitHubState>)
  ) {
    const updates = typeof partial === "function" ? partial(state) : partial;
    state = { ...state, ...updates };
    listeners.forEach((l) => l());
  }

  function subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  function initialize(token: string) {
    octokit = new Octokit({ auth: token });
    wrapOctokitWithHooks(octokit);
    batcher = new GraphQLBatcher(octokit);
    setOctokit(octokit);

    setState({ ready: true, error: null });

    // Revalidate teams in background
    fetchUserTeams();
  }

  function reset() {
    octokit = null;
    batcher = null;
    setOctokit(null);
    queryClient.clear();
    setState({
      ready: false,
      error: null,
      prChecks: new Map(),
    });
  }

  // ---------------------------------------------------------------------------
  // PR Checks
  // ---------------------------------------------------------------------------

  function getPRCheckKey(owner: string, repo: string, number: number) {
    return `${owner}/${repo}/${number}`;
  }

  async function fetchPRChecks(owner: string, repo: string, number: number) {
    if (!octokit) return;

    const key = getPRCheckKey(owner, repo, number);

    setState((s) => {
      const newChecks = new Map(s.prChecks);
      newChecks.set(key, {
        status: s.prChecks.get(key)?.status || null,
        loading: true,
        lastFetchedAt: s.prChecks.get(key)?.lastFetchedAt || null,
      });
      return { prChecks: newChecks };
    });

    try {
      const prData = await getPR(owner, repo, number);
      const [checksData, workflowRunsData] = await Promise.all([
        getPRChecksForSha(owner, repo, prData.head.sha),
        getWorkflowRunsForSha(owner, repo, prData.head.sha).catch(() => ({
          workflow_runs: [],
        })),
      ]);

      const checkRuns = checksData.checkRuns || [];
      const statuses = checksData.status?.statuses || [];

      // Check for workflow runs awaiting approval (fork PRs)
      const workflowRunsAwaitingApproval = workflowRunsData.workflow_runs
        .filter((run) => run.conclusion === "action_required")
        .map((run) => ({
          id: run.id,
          name: run.name || "Workflow",
          html_url: run.html_url,
        }));

      let checks: CheckStatus["checks"] = "none";

      // If there are workflow runs awaiting approval and no other checks, show action_required
      if (workflowRunsAwaitingApproval.length > 0) {
        // Check if there are any other actual check runs or statuses
        if (checkRuns.length === 0 && statuses.length === 0) {
          checks = "action_required";
        } else {
          // There are other checks, evaluate them first
          const allChecks = [
            ...checkRuns.map((c) =>
              c.status === "completed" ? c.conclusion : "pending"
            ),
            ...statuses.map((s) => s.state),
          ];

          if (allChecks.some((c) => c === "failure" || c === "error")) {
            checks = "failure";
          } else if (allChecks.some((c) => c === "pending" || c === null)) {
            checks = "pending";
          } else {
            // All checks passed but there are workflows awaiting approval
            checks = "action_required";
          }
        }
      } else if (checkRuns.length > 0 || statuses.length > 0) {
        const allChecks = [
          ...checkRuns.map((c) =>
            c.status === "completed" ? c.conclusion : "pending"
          ),
          ...statuses.map((s) => s.state),
        ];

        if (allChecks.some((c) => c === "failure" || c === "error")) {
          checks = "failure";
        } else if (allChecks.some((c) => c === "pending" || c === null)) {
          checks = "pending";
        } else {
          checks = "success";
        }
      }

      const prState: CheckStatus["state"] = prData.merged
        ? "merged"
        : prData.draft
          ? "draft"
          : prData.state === "open"
            ? "open"
            : "closed";

      setState((s) => {
        const newChecks = new Map(s.prChecks);
        newChecks.set(key, {
          status: {
            checks,
            state: prState,
            mergeable: prData.mergeable,
            workflowRunsAwaitingApproval:
              workflowRunsAwaitingApproval.length > 0
                ? workflowRunsAwaitingApproval
                : undefined,
          },
          loading: false,
          lastFetchedAt: Date.now(),
        });
        return { prChecks: newChecks };
      });
    } catch {
      setState((s) => {
        const newChecks = new Map(s.prChecks);
        newChecks.set(key, {
          status: s.prChecks.get(key)?.status || null,
          loading: false,
          lastFetchedAt: Date.now(),
        });
        return { prChecks: newChecks };
      });
    }
  }

  function refreshAllPRChecks() {
    for (const key of state.prChecks.keys()) {
      const [owner, repo, number] = key.split("/");
      if (owner && repo && number) {
        fetchPRChecks(owner, repo, parseInt(number, 10));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // API Methods (with caching and deduplication)
  // ---------------------------------------------------------------------------

  function invalidatePR(owner: string, repo: string, number: number) {
    // Prefix match: invalidates the PR header AND every sub-query
    // (files, commits, push-versions, comments, reviews, conversation, timeline).
    queryClient.invalidateQueries(queries.pullRequest(owner, repo, number));
    queryClient.invalidateQueries({ queryKey: ["pr-list"] });
  }

  function searchPRs(query: string, page = 1, perPage = 30) {
    return queryClient.fetchQuery(queries.searchPRs(query, page, perPage));
  }

  async function fetchUserTeams() {
    if (!octokit) return;
    try {
      const result = await octokit.request("GET /user/teams", {
        per_page: 100,
      });
      userTeamsCache = (
        result.data as Array<{ organization: { login: string }; slug: string }>
      ).map((t) => ({ org: t.organization.login, slug: t.slug }));
    } catch {
      // Silently fail — teams are optional
    }
  }

  async function fetchInvolvedPRs(): Promise<PRSearchResult[]> {
    try {
      const teams = getCachedTeams();
      const MAX_OR = 5;
      const batches: string[] = [];

      for (let i = 0; i < teams.length; i += MAX_OR) {
        const batch = teams.slice(i, i + MAX_OR);
        const qualifiers = batch
          .map((t) => `team-review-requested:${t.org}/${t.slug}`)
          .join(" OR ");
        batches.push(
          `is:pr (involves:@me OR ${qualifiers} ) sort:updated-desc`
        );
      }

      if (batches.length === 0) {
        batches.push("is:pr involves:@me sort:updated-desc");
      }

      const results = await Promise.all(
        batches.map((q) => searchPRs(q, 1, 50))
      );
      const seen = new Set<number>();
      const allItems: PRSearchResult[] = [];
      for (const r of results) {
        for (const item of (r.items || []) as PRSearchResult[]) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            allItems.push(item);
          }
        }
      }
      return allItems;
    } catch {
      return [];
    }
  }

  function searchRepos(query: string) {
    return queryClient.fetchQuery(queries.searchRepos(query));
  }

  function searchUsers(query: string) {
    return queryClient.fetchQuery(queries.searchUsers(query));
  }

  function getPR(
    owner: string,
    repo: string,
    number: number
  ): Promise<PullRequest> {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(queries.pullRequest(owner, repo, number));
  }

  function getPRFiles(
    owner: string,
    repo: string,
    number: number
  ): Promise<PullRequestFile[]> {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(
      queries.pullRequestFiles(owner, repo, number)
    );
  }

  function getCommitFiles(
    owner: string,
    repo: string,
    sha: string,
    prKey?: string
  ): Promise<PullRequestFile[]> {
    return queryClient.fetchQuery(queries.commitFiles(owner, repo, sha, prKey));
  }

  function getSingleCommit(
    owner: string,
    repo: string,
    ref: string,
    prKey?: string
  ): Promise<PRCommit> {
    return queryClient.fetchQuery(
      queries.singleCommit(owner, repo, ref, prKey)
    );
  }

  function getRawGitCommit(
    owner: string,
    repo: string,
    ref: string,
    prKey?: string
  ): Promise<{ verification: { payload: string } | null }> {
    return queryClient.fetchQuery(
      queries.rawGitCommit(owner, repo, ref, prKey)
    );
  }

  function getMergeCommitFiles(
    owner: string,
    repo: string,
    mergeSha: string,
    parentSha: string,
    prKey?: string
  ): Promise<PullRequestFile[]> {
    return queryClient.fetchQuery(
      queries.mergeCommitFiles(owner, repo, mergeSha, parentSha, prKey)
    );
  }

  function getRawCompareDiff(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
    prKey?: string
  ): Promise<string> {
    return queryClient.fetchQuery(
      queries.rawCompareDiff(owner, repo, baseSha, headSha, prKey)
    );
  }

  function getPRFilesForRange(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
    prKey?: string
  ): Promise<PullRequestFile[]> {
    return queryClient.fetchQuery(
      queries.prFilesForRange(owner, repo, baseSha, headSha, prKey)
    );
  }

  function getPRComments(
    owner: string,
    repo: string,
    number: number
  ): Promise<ReviewComment[]> {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(
      queries.pullRequestComments(owner, repo, number)
    );
  }

  async function createPRComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
    options?: {
      reply_to_id?: number;
      commit_id?: string;
      path?: string;
      line?: number;
      side?: "LEFT" | "RIGHT";
    }
  ): Promise<ReviewComment> {
    if (!octokit) throw new Error("Not initialized");

    let result: ReviewComment;

    if (options?.reply_to_id) {
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies",
        {
          owner,
          repo,
          pull_number: number,
          comment_id: options.reply_to_id,
          body,
        }
      );
      result = data;
    } else {
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments",
        {
          owner,
          repo,
          pull_number: number,
          body,
          commit_id: options?.commit_id!,
          path: options?.path!,
          line: options?.line!,
          side: options?.side ?? "RIGHT",
        }
      );
      result = data;
    }

    queryClient.invalidateQueries({
      queryKey: queries.pullRequestComments(owner, repo, number).queryKey,
    });
    return result;
  }

  function getPRReviews(
    owner: string,
    repo: string,
    number: number
  ): Promise<Review[]> {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(
      queries.pullRequestReviews(owner, repo, number)
    );
  }

  async function createPRReview(
    owner: string,
    repo: string,
    number: number,
    options: {
      commit_id: string;
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body?: string;
      comments?: Array<{
        path: string;
        line: number;
        body: string;
        side?: "LEFT" | "RIGHT";
        start_line?: number;
      }>;
    }
  ): Promise<Review> {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      {
        owner,
        repo,
        pull_number: number,
        commit_id: options.commit_id,
        event: options.event,
        body: options.body ?? "",
        comments: options.comments ?? [],
      }
    );

    invalidatePR(owner, repo, number);
    return data;
  }

  async function submitPRReview(
    owner: string,
    repo: string,
    number: number,
    reviewId: number,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body?: string
  ): Promise<Review> {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events",
      {
        owner,
        repo,
        pull_number: number,
        review_id: reviewId,
        event,
        body: body ?? "",
      }
    );

    invalidatePR(owner, repo, number);
    return data;
  }

  async function deletePRReview(
    owner: string,
    repo: string,
    number: number,
    reviewId: number
  ): Promise<void> {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}",
      {
        owner,
        repo,
        pull_number: number,
        review_id: reviewId,
      }
    );
    invalidatePR(owner, repo, number);
  }

  function getPRChecksForSha(owner: string, repo: string, sha: string) {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(queries.checksByCommit(owner, repo, sha));
  }

  function getWorkflowRunsForSha(owner: string, repo: string, sha: string) {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(
      queries.workflowRunsByCommit(owner, repo, sha)
    );
  }

  async function approveWorkflowRun(
    owner: string,
    repo: string,
    runId: number
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve",
      {
        owner,
        repo,
        run_id: runId,
      }
    );

    queryClient.invalidateQueries({ queryKey: ["workflow-runs", owner, repo] });
  }

  async function mergePR(
    owner: string,
    repo: string,
    number: number,
    options?: {
      merge_method?: "merge" | "squash" | "rebase";
      commit_title?: string;
      commit_message?: string;
    }
  ) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      {
        owner,
        repo,
        pull_number: number,
        merge_method: options?.merge_method ?? "squash",
        commit_title: options?.commit_title,
        commit_message: options?.commit_message,
      }
    );

    invalidatePR(owner, repo, number);
    return data;
  }

  async function dequeuePullRequest(
    owner: string,
    repo: string,
    number: number,
    prNodeId: string
  ): Promise<void> {
    if (!batcher) throw new Error("Not initialized");
    await batcher.query(
      `mutation ($input: DequeuePullRequestInput!) { dequeuePullRequest(input: $input) { mergeQueueEntry { id } } }`,
      { input: { id: prNodeId } }
    );
    invalidatePR(owner, repo, number);
  }

  async function enqueuePullRequest(
    owner: string,
    repo: string,
    number: number,
    prNodeId: string
  ): Promise<void> {
    if (!batcher) throw new Error("Not initialized");
    await batcher.query(
      `mutation ($input: EnqueuePullRequestInput!) { enqueuePullRequest(input: $input) { mergeQueueEntry { id } } }`,
      { input: { pullRequestId: prNodeId } }
    );
    invalidatePR(owner, repo, number);
  }

  function getPRCommits(owner: string, repo: string, number: number) {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(
      queries.pullRequestCommits(owner, repo, number)
    );
  }

  function getCommitsForHeadSha(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
    prKey?: string
  ): Promise<components["schemas"]["commit"][]> {
    return queryClient.fetchQuery(
      queries.commitsForHeadSha(owner, repo, baseSha, headSha, prKey)
    );
  }

  async function requestReviewers(
    owner: string,
    repo: string,
    number: number,
    reviewers: string[]
  ) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      {
        owner,
        repo,
        pull_number: number,
        reviewers,
      }
    );

    invalidatePR(owner, repo, number);
    return data;
  }

  async function removeReviewers(
    owner: string,
    repo: string,
    number: number,
    reviewers: string[]
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      {
        owner,
        repo,
        pull_number: number,
        reviewers,
      }
    );

    invalidatePR(owner, repo, number);
  }

  function getRepoCollaborators(owner: string, repo: string) {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(queries.collaborators(owner, repo));
  }

  async function addAssignees(
    owner: string,
    repo: string,
    issueNumber: number,
    assignees: string[]
  ) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/assignees",
      {
        owner,
        repo,
        issue_number: issueNumber,
        assignees,
      }
    );

    invalidatePR(owner, repo, issueNumber);
    return data;
  }

  async function removeAssignees(
    owner: string,
    repo: string,
    issueNumber: number,
    assignees: string[]
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "DELETE /repos/{owner}/{repo}/issues/{issue_number}/assignees",
      {
        owner,
        repo,
        issue_number: issueNumber,
        assignees,
      }
    );

    invalidatePR(owner, repo, issueNumber);
  }

  function getRepoLabels(owner: string, repo: string) {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(queries.labels(owner, repo));
  }

  async function addLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[]
  ) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
      {
        owner,
        repo,
        issue_number: issueNumber,
        labels,
      }
    );

    invalidatePR(owner, repo, issueNumber);
    return data;
  }

  async function removeLabel(
    owner: string,
    repo: string,
    issueNumber: number,
    labelName: string
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
      {
        owner,
        repo,
        issue_number: issueNumber,
        name: labelName,
      }
    );

    invalidatePR(owner, repo, issueNumber);
  }

  async function convertToDraft(owner: string, repo: string, number: number) {
    if (!batcher) throw new Error("Not initialized");

    const prData = await batcher.query<{
      repository: { pullRequest: { id: string } };
    }>(
      `query ($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } } }`,
      { owner, repo, number }
    );

    await batcher.query(
      `mutation ($input: ConvertPullRequestToDraftInput!) { convertPullRequestToDraft(input: $input) { pullRequest { id } } }`,
      { input: { pullRequestId: prData.repository.pullRequest.id } }
    );

    invalidatePR(owner, repo, number);
  }

  async function markReadyForReview(
    owner: string,
    repo: string,
    number: number
  ) {
    if (!batcher) throw new Error("Not initialized");

    const prData = await batcher.query<{
      repository: { pullRequest: { id: string } };
    }>(
      `query ($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } } }`,
      { owner, repo, number }
    );

    await batcher.query(
      `mutation ($input: MarkPullRequestReadyForReviewInput!) { markPullRequestReadyForReview(input: $input) { pullRequest { id } } }`,
      { input: { pullRequestId: prData.repository.pullRequest.id } }
    );

    invalidatePR(owner, repo, number);
  }

  async function updateBranch(owner: string, repo: string, number: number) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch",
      {
        owner,
        repo,
        pull_number: number,
      }
    );

    invalidatePR(owner, repo, number);
    return data;
  }

  // Reaction types: +1, -1, laugh, hooray, confused, heart, rocket, eyes
  type ReactionContent =
    | "+1"
    | "-1"
    | "laugh"
    | "hooray"
    | "confused"
    | "heart"
    | "rocket"
    | "eyes";

  function getIssueReactions(owner: string, repo: string, issueNumber: number) {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(
      queries.issueReactions(owner, repo, issueNumber)
    );
  }

  async function addIssueReaction(
    owner: string,
    repo: string,
    issueNumber: number,
    content: ReactionContent
  ) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/reactions",
      {
        owner,
        repo,
        issue_number: issueNumber,
        content,
      }
    );

    queryClient.invalidateQueries({
      queryKey: queries.issueReactions(owner, repo, issueNumber).queryKey,
    });
    return data;
  }

  async function deleteIssueReaction(
    owner: string,
    repo: string,
    issueNumber: number,
    reactionId: number
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "DELETE /repos/{owner}/{repo}/issues/{issue_number}/reactions/{reaction_id}",
      {
        owner,
        repo,
        issue_number: issueNumber,
        reaction_id: reactionId,
      }
    );

    queryClient.invalidateQueries({
      queryKey: queries.issueReactions(owner, repo, issueNumber).queryKey,
    });
  }

  function getCommentReactions(owner: string, repo: string, commentId: number) {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(
      queries.commentReactions(owner, repo, commentId)
    );
  }

  async function addCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    content: ReactionContent
  ) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
      {
        owner,
        repo,
        comment_id: commentId,
        content,
      }
    );

    queryClient.invalidateQueries({
      queryKey: queries.commentReactions(owner, repo, commentId).queryKey,
    });
    return data;
  }

  async function deleteCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    reactionId: number
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions/{reaction_id}",
      {
        owner,
        repo,
        comment_id: commentId,
        reaction_id: reactionId,
      }
    );

    queryClient.invalidateQueries({
      queryKey: queries.commentReactions(owner, repo, commentId).queryKey,
    });
  }

  // Pull Request Review Comment Reactions (different from issue comments)
  function getReviewCommentReactions(
    owner: string,
    repo: string,
    commentId: number
  ) {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(
      queries.reviewCommentReactions(owner, repo, commentId)
    );
  }

  async function addReviewCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    content: ReactionContent
  ) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
      {
        owner,
        repo,
        comment_id: commentId,
        content,
      }
    );

    queryClient.invalidateQueries({
      queryKey: queries.reviewCommentReactions(owner, repo, commentId).queryKey,
    });
    return data;
  }

  async function deleteReviewCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    reactionId: number
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions/{reaction_id}",
      {
        owner,
        repo,
        comment_id: commentId,
        reaction_id: reactionId,
      }
    );

    queryClient.invalidateQueries({
      queryKey: queries.reviewCommentReactions(owner, repo, commentId).queryKey,
    });
  }

  async function closePR(owner: string, repo: string, number: number) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo,
        pull_number: number,
        state: "closed",
      }
    );

    queryClient.setQueryData(
      queries.pullRequest(owner, repo, number).queryKey,
      data as PullRequest
    );
    invalidatePR(owner, repo, number);
    return data;
  }

  async function updatePR(
    owner: string,
    repo: string,
    number: number,
    params: { title?: string; body?: string; base?: string }
  ) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo,
        pull_number: number,
        title: params.title,
        body: params.body,
        base: params.base,
      }
    );

    queryClient.setQueryData(
      queries.pullRequest(owner, repo, number).queryKey,
      data as PullRequest
    );
    invalidatePR(owner, repo, number);
    return data as PullRequest;
  }

  async function getRepoBranches(owner: string, repo: string) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/branches",
      {
        owner,
        repo,
        per_page: 100,
      }
    );

    return data as Array<{ name: string; commit: { sha: string } }>;
  }

  async function reopenPR(owner: string, repo: string, number: number) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo,
        pull_number: number,
        state: "open",
      }
    );

    queryClient.setQueryData(
      queries.pullRequest(owner, repo, number).queryKey,
      data as PullRequest
    );
    invalidatePR(owner, repo, number);
    return data;
  }

  async function deleteBranch(owner: string, repo: string, branch: string) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
      owner,
      repo,
      ref: `heads/${branch}`,
    });
  }

  async function restoreBranch(
    owner: string,
    repo: string,
    branch: string,
    sha: string
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  function getPRConversation(
    owner: string,
    repo: string,
    number: number
  ): Promise<IssueComment[]> {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(
      queries.pullRequestConversation(owner, repo, number)
    );
  }

  async function createPRConversationComment(
    owner: string,
    repo: string,
    number: number,
    body: string
  ): Promise<IssueComment> {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number: number,
        body,
      }
    );
    queryClient.invalidateQueries({
      queryKey: queries.pullRequestConversation(owner, repo, number).queryKey,
    });
    return data;
  }

  function getPRTimeline(
    owner: string,
    repo: string,
    number: number
  ): Promise<TimelineEvent[]> {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(
      queries.pullRequestTimeline(owner, repo, number)
    );
  }

  function getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    prKey?: string
  ): Promise<string> {
    return queryClient.fetchQuery(
      queries.fileContent(owner, repo, path, ref, prKey)
    );
  }

  function getPushVersions(
    owner: string,
    repo: string,
    number: number
  ): Promise<PushVersion[]> {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(
      queries.pullRequestPushVersions(owner, repo, number)
    );
  }

  // ---------------------------------------------------------------------------
  // GraphQL Methods
  // ---------------------------------------------------------------------------

  async function graphql<T>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    if (!batcher) throw new Error("Not initialized");
    return batcher.query<T>(query, variables);
  }

  async function getPREnrichment(
    prs: Array<{ owner: string; repo: string; number: number }>
  ): Promise<Map<string, PREnrichment>> {
    if (!batcher || prs.length === 0) return new Map();

    const prQueries = prs
      .map(
        (pr, idx) => `
      pr${idx}: repository(owner: "${pr.owner}", name: "${pr.repo}") {
        pullRequest(number: ${pr.number}) {
          number
          updatedAt
          isReadByViewer
          changedFiles
          additions
          deletions
          isInMergeQueue
          reviewDecision
          latestOpinionatedReviews(first: 10) {
            nodes {
              author {
                login
                avatarUrl
              }
              state
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                committedDate
                statusCheckRollup {
                  state
                  contexts(first: 50) {
                    nodes {
                      __typename
                      ... on CheckRun {
                        name
                        conclusion
                        status
                      }
                      ... on StatusContext {
                        context
                        state
                      }
                    }
                  }
                }
              }
            }
          }
          viewerLatestReview {
            submittedAt
          }
        }
      }
    `
      )
      .join("\n");

    type CheckContext =
      | {
          __typename: "CheckRun";
          name: string;
          conclusion: string | null;
          status: string;
        }
      | {
          __typename: "StatusContext";
          context: string;
          state: string;
        };

    const data = await batcher.query<
      Record<
        string,
        {
          pullRequest: {
            number: number;
            updatedAt: string;
            isReadByViewer: boolean;
            changedFiles: number;
            additions: number;
            deletions: number;
            isInMergeQueue: boolean;
            reviewDecision:
              | "APPROVED"
              | "CHANGES_REQUESTED"
              | "REVIEW_REQUIRED"
              | null;
            latestOpinionatedReviews: {
              nodes: Array<{
                author: { login: string; avatarUrl: string } | null;
                state: "APPROVED" | "CHANGES_REQUESTED";
              }>;
            };
            commits: {
              nodes: Array<{
                commit: {
                  committedDate: string;
                  statusCheckRollup: {
                    state:
                      | "EXPECTED"
                      | "ERROR"
                      | "FAILURE"
                      | "PENDING"
                      | "SUCCESS";
                    contexts: {
                      nodes: CheckContext[];
                    };
                  } | null;
                };
              }>;
            };
            viewerLatestReview: { submittedAt: string } | null;
          } | null;
        }
      >
    >(`query { ${prQueries} }`);

    const enrichmentMap = new Map<string, PREnrichment>();

    prs.forEach((pr, idx) => {
      const result = data[`pr${idx}`]?.pullRequest;
      if (result) {
        const lastCommit = result.commits.nodes[0]?.commit;
        const lastCommitAt = lastCommit?.committedDate || null;
        const viewerLastReviewAt =
          result.viewerLatestReview?.submittedAt || null;
        let hasNewChanges = false;
        if (viewerLastReviewAt && lastCommitAt) {
          hasNewChanges = new Date(lastCommitAt) > new Date(viewerLastReviewAt);
        }

        // Map GraphQL status to our CI status
        const statusState = lastCommit?.statusCheckRollup?.state;
        let ciStatus: PREnrichment["ciStatus"] = "none";
        if (statusState) {
          if (statusState === "SUCCESS") {
            ciStatus = "success";
          } else if (statusState === "FAILURE" || statusState === "ERROR") {
            ciStatus = "failure";
          } else if (statusState === "PENDING" || statusState === "EXPECTED") {
            ciStatus = "pending";
          }
        }

        // Parse check contexts for detailed info
        const contexts = lastCommit?.statusCheckRollup?.contexts?.nodes || [];
        const ciChecks: PREnrichment["ciChecks"] = contexts.map((ctx) => {
          if (ctx.__typename === "CheckRun") {
            let state: "pending" | "success" | "failure" | "skipped" =
              "pending";
            if (ctx.status === "COMPLETED") {
              if (ctx.conclusion === "SUCCESS") {
                state = "success";
              } else if (
                ctx.conclusion === "SKIPPED" ||
                ctx.conclusion === "NEUTRAL" ||
                ctx.conclusion === "CANCELLED"
              ) {
                state = "skipped";
              } else {
                state = "failure";
              }
            }
            return { name: ctx.name, state };
          } else {
            // StatusContext
            const state =
              ctx.state === "SUCCESS"
                ? "success"
                : ctx.state === "FAILURE" || ctx.state === "ERROR"
                  ? "failure"
                  : "pending";
            return { name: ctx.context, state };
          }
        });

        // Build summary
        let ciSummary = "";
        if (ciChecks.length > 0) {
          const passed = ciChecks.filter((c) => c.state === "success").length;
          const failed = ciChecks.filter((c) => c.state === "failure").length;
          const pending = ciChecks.filter((c) => c.state === "pending").length;
          const skipped = ciChecks.filter((c) => c.state === "skipped").length;

          if (failed > 0) {
            const failedCheck = ciChecks.find((c) => c.state === "failure");
            ciSummary = failedCheck ? failedCheck.name : `${failed} failed`;
          } else if (pending > 0) {
            const pendingCheck = ciChecks.find((c) => c.state === "pending");
            ciSummary = pendingCheck ? pendingCheck.name : `${pending} running`;
          } else {
            const nonSkipped = ciChecks.length - skipped;
            ciSummary =
              nonSkipped > 0 ? `${passed}/${nonSkipped} passed` : "All skipped";
          }
        }

        // Parse latest reviews - deduplicate by user (keep latest)
        const reviewsByUser = new Map<
          string,
          {
            login: string;
            avatarUrl: string;
            state: "APPROVED" | "CHANGES_REQUESTED";
          }
        >();
        for (const review of result.latestOpinionatedReviews?.nodes || []) {
          if (review.author) {
            reviewsByUser.set(review.author.login, {
              login: review.author.login,
              avatarUrl: review.author.avatarUrl,
              state: review.state,
            });
          }
        }
        const latestReviews = Array.from(reviewsByUser.values());

        enrichmentMap.set(`${pr.owner}/${pr.repo}/${pr.number}`, {
          changedFiles: result.changedFiles,
          additions: result.additions,
          deletions: result.deletions,
          updatedAt: result.updatedAt,
          isReadByViewer: result.isReadByViewer,
          lastCommitAt,
          viewerLastReviewAt,
          hasNewChanges,
          ciStatus,
          ciSummary,
          ciChecks,
          reviewDecision: result.reviewDecision,
          latestReviews,
          inMergeQueue: result.isInMergeQueue,
        });
      }
    });

    return enrichmentMap;
  }

  async function getReviewThreads(
    owner: string,
    repo: string,
    number: number
  ): Promise<{
    threads: ReviewThread[];
    viewerPermission: string | null;
    viewerCanMergeAsAdmin: boolean;
    hasMergeQueue: boolean;
    isInMergeQueue: boolean;
  }> {
    if (!batcher) throw new Error("Not initialized");

    // Raw GraphQL response type (comments include pullRequestReview)
    interface RawReviewThread {
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      resolvedBy: { login: string; avatarUrl: string } | null;
      comments: {
        nodes: Array<{
          id: string;
          databaseId: number;
          body: string;
          bodyHTML: string;
          path: string;
          line: number | null;
          originalLine: number | null;
          startLine: number | null;
          diffHunk: string | null;
          author: { login: string; avatarUrl: string } | null;
          createdAt: string;
          updatedAt: string;
          replyTo: { databaseId: number } | null;
          pullRequestReview: {
            databaseId: number;
            author: { login: string; avatarUrl: string } | null;
          } | null;
        }>;
      };
    }

    const data = await batcher.query<{
      repository: {
        viewerPermission: string | null;
        mergeQueue: { id: string } | null;
        pullRequest: {
          viewerCanMergeAsAdmin: boolean;
          isInMergeQueue: boolean;
          reviewThreads: { nodes: RawReviewThread[] };
        };
      };
    }>(
      `
      query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          viewerPermission
          mergeQueue {
            id
          }
          pullRequest(number: $number) {
            viewerCanMergeAsAdmin
            isInMergeQueue
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                isOutdated
                resolvedBy { login avatarUrl }
                comments(first: 100) {
                  nodes {
                    id
                    databaseId
                    body
                    bodyHTML
                    path
                    line
                    originalLine
                    startLine
                    diffHunk
                    author { login avatarUrl }
                    createdAt
                    updatedAt
                    replyTo { databaseId }
                    pullRequestReview {
                      databaseId
                      author { login avatarUrl }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
      { owner, repo, number }
    );

    // Extract pullRequestReview from first comment into thread object
    const threads = data.repository.pullRequest.reviewThreads.nodes.map(
      (thread) => {
        const firstComment = thread.comments.nodes[0];
        return {
          ...thread,
          pullRequestReview: firstComment?.pullRequestReview ?? null,
        };
      }
    );

    return {
      threads,
      viewerPermission: data.repository.viewerPermission,
      viewerCanMergeAsAdmin: data.repository.pullRequest.viewerCanMergeAsAdmin,
      hasMergeQueue: data.repository.mergeQueue !== null,
      isInMergeQueue: data.repository.pullRequest.isInMergeQueue,
    };
  }

  async function resolveThread(threadId: string): Promise<void> {
    if (!batcher) throw new Error("Not initialized");
    await batcher.query(
      `mutation ($input: ResolveReviewThreadInput!) { resolveReviewThread(input: $input) { thread { id } } }`,
      { input: { threadId } }
    );
  }

  async function unresolveThread(threadId: string): Promise<void> {
    if (!batcher) throw new Error("Not initialized");
    await batcher.query(
      `mutation ($input: UnresolveReviewThreadInput!) { unresolveReviewThread(input: $input) { thread { id } } }`,
      { input: { threadId } }
    );
  }

  async function getPendingReview(
    owner: string,
    repo: string,
    number: number
  ): Promise<PendingReview | null> {
    if (!batcher) throw new Error("Not initialized");

    const data = await batcher.query<{
      repository: {
        pullRequest: {
          reviews: { nodes: PendingReview[] };
        };
      };
    }>(
      `
      query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviews(first: 10, states: [PENDING]) {
              nodes {
                id
                databaseId
                viewerDidAuthor
                comments(first: 100) {
                    nodes { id databaseId body path line startLine }
                }
              }
            }
          }
        }
      }
    `,
      { owner, repo, number }
    );

    return (
      data.repository.pullRequest.reviews.nodes.find(
        (r) => r.viewerDidAuthor
      ) || null
    );
  }

  async function addPendingComment(
    owner: string,
    repo: string,
    number: number,
    options: { path: string; line: number; body: string; startLine?: number }
  ): Promise<{
    reviewId: string;
    commentId: string;
    commentDatabaseId: number;
  }> {
    if (!batcher) throw new Error("Not initialized");

    const prData = await batcher.query<{
      repository: { pullRequest: { id: string } };
    }>(
      `query ($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } } }`,
      { owner, repo, number }
    );

    const input: Record<string, unknown> = {
      pullRequestId: prData.repository.pullRequest.id,
      path: options.path,
      line: options.line,
      body: options.body,
    };

    if (options.startLine && options.startLine !== options.line) {
      input.startLine = options.startLine;
    }

    const data = await batcher.query<{
      addPullRequestReviewComment: {
        comment: {
          id: string;
          databaseId: number;
          pullRequestReview: { id: string };
        };
      };
    }>(
      `mutation ($input: AddPullRequestReviewCommentInput!) { addPullRequestReviewComment(input: $input) { comment { id databaseId pullRequestReview { id } } } }`,
      { input }
    );

    return {
      reviewId: data.addPullRequestReviewComment.comment.pullRequestReview.id,
      commentId: data.addPullRequestReviewComment.comment.id,
      commentDatabaseId: data.addPullRequestReviewComment.comment.databaseId,
    };
  }

  async function deletePendingComment(commentId: string): Promise<void> {
    if (!batcher) throw new Error("Not initialized");
    await batcher.query(
      `mutation ($input: DeletePullRequestReviewCommentInput!) { deletePullRequestReviewComment(input: $input) { pullRequestReview { id } } }`,
      { input: { id: commentId } }
    );
  }

  async function updatePendingComment(
    commentId: string,
    body: string
  ): Promise<void> {
    if (!batcher) throw new Error("Not initialized");
    await batcher.query(
      `mutation ($input: UpdatePullRequestReviewCommentInput!) { updatePullRequestReviewComment(input: $input) { pullRequestReviewComment { id } } }`,
      { input: { pullRequestReviewCommentId: commentId, body } }
    );
  }

  async function submitPendingReview(
    reviewId: string,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body?: string
  ): Promise<void> {
    if (!batcher) throw new Error("Not initialized");
    await batcher.query(
      `mutation ($input: SubmitPullRequestReviewInput!) { submitPullRequestReview(input: $input) { pullRequestReview { id } } }`,
      { input: { pullRequestReviewId: reviewId, event, body: body ?? "" } }
    );
  }

  async function getReviewReactions(reviewNodeId: string): Promise<Reaction[]> {
    if (!batcher) throw new Error("Not initialized");

    const data = await batcher.query<{
      node: {
        reactions: {
          nodes: Array<{
            id: string;
            databaseId: number;
            content: string;
            user: { login: string };
          }>;
        };
      } | null;
    }>(
      `query ($id: ID!) {
        node(id: $id) {
          ... on PullRequestReview {
            reactions(first: 100) {
              nodes {
                id
                databaseId
                content
                user { login }
              }
            }
          }
        }
      }`,
      { id: reviewNodeId }
    );

    if (!data.node) return [];

    return data.node.reactions.nodes.map(
      (r) =>
        ({
          id: r.databaseId,
          node_id: r.id,
          content: GRAPHQL_REACTION_TO_CONTENT[r.content] ?? r.content,
          user: { login: r.user.login },
        }) as Reaction
    );
  }

  // Map REST reaction content values to GraphQL enum values
  const REACTION_CONTENT_TO_GRAPHQL: Record<ReactionContent, string> = {
    "+1": "THUMBS_UP",
    "-1": "THUMBS_DOWN",
    laugh: "LAUGH",
    hooray: "HOORAY",
    confused: "CONFUSED",
    heart: "HEART",
    rocket: "ROCKET",
    eyes: "EYES",
  };

  // Map GraphQL enum values back to REST content strings
  const GRAPHQL_REACTION_TO_CONTENT: Record<string, ReactionContent> = {
    THUMBS_UP: "+1",
    THUMBS_DOWN: "-1",
    LAUGH: "laugh",
    HOORAY: "hooray",
    CONFUSED: "confused",
    HEART: "heart",
    ROCKET: "rocket",
    EYES: "eyes",
  };

  async function addReviewReaction(
    reviewNodeId: string,
    content: ReactionContent
  ): Promise<Reaction> {
    if (!batcher) throw new Error("Not initialized");

    const data = await batcher.query<{
      addReaction: {
        reaction: {
          id: string;
          databaseId: number;
          content: string;
          user: { login: string };
        };
      };
    }>(
      `mutation ($input: AddReactionInput!) {
        addReaction(input: $input) {
          reaction {
            id
            databaseId
            content
            user { login }
          }
        }
      }`,
      {
        input: {
          subjectId: reviewNodeId,
          content: REACTION_CONTENT_TO_GRAPHQL[content],
        },
      }
    );

    return {
      id: data.addReaction.reaction.databaseId,
      node_id: data.addReaction.reaction.id,
      content:
        GRAPHQL_REACTION_TO_CONTENT[data.addReaction.reaction.content] ??
        data.addReaction.reaction.content,
      user: { login: data.addReaction.reaction.user.login },
    } as Reaction;
  }

  async function deleteReviewReaction(reactionNodeId: string): Promise<void> {
    if (!batcher) throw new Error("Not initialized");

    await batcher.query(
      `mutation ($input: RemoveReactionInput!) {
        removeReaction(input: $input) {
          reaction { id }
        }
      }`,
      { input: { subjectId: reactionNodeId } }
    );
  }

  async function updateComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ): Promise<ReviewComment> {
    if (!octokit) throw new Error("Not initialized");
    const { data } = await octokit.request(
      "PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}",
      {
        owner,
        repo,
        comment_id: commentId,
        body,
      }
    );
    return data;
  }

  async function deleteComment(
    owner: string,
    repo: string,
    commentId: number
  ): Promise<void> {
    if (!octokit) throw new Error("Not initialized");
    await octokit.request(
      "DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}",
      {
        owner,
        repo,
        comment_id: commentId,
      }
    );
  }

  async function updateIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ): Promise<ReviewComment> {
    if (!octokit) throw new Error("Not initialized");
    const { data } = await octokit.request(
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      {
        owner,
        repo,
        comment_id: commentId,
        body,
      }
    );
    return data as unknown as ReviewComment;
  }

  async function deleteIssueComment(
    owner: string,
    repo: string,
    commentId: number
  ): Promise<void> {
    if (!octokit) throw new Error("Not initialized");
    await octokit.request(
      "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}",
      {
        owner,
        repo,
        comment_id: commentId,
      }
    );
  }

  function getUserProfile(login: string): Promise<UserProfile> {
    if (!octokit) throw new Error("Not initialized");
    return queryClient.fetchQuery(queries.userByLogin(login));
  }

  return {
    // State
    getState,
    subscribe,
    initialize,
    reset,
    setOnUnauthorized,
    setOnRateLimited,
    // State actions
    fetchPRChecks,
    refreshAllPRChecks,
    getPRCheckKey,
    // API methods
    searchPRs,
    fetchInvolvedPRs,
    fetchUserTeams,
    searchRepos,
    searchUsers,
    getPR,
    getPRFiles,
    getPRFilesForRange,
    getCommitFiles,
    getSingleCommit,
    getRawGitCommit,
    getMergeCommitFiles,
    getRawCompareDiff,
    getPRComments,
    createPRComment,
    getPRReviews,
    createPRReview,
    submitPRReview,
    deletePRReview,
    getPRChecks: getPRChecksForSha,
    getWorkflowRuns: getWorkflowRunsForSha,
    approveWorkflowRun,
    mergePR,
    dequeuePullRequest,
    enqueuePullRequest,
    getPRCommits,
    getCommitsForHeadSha,
    getPRConversation,
    createPRConversationComment,
    getPRTimeline,
    getPushVersions,
    getFileContent,
    requestReviewers,
    removeReviewers,
    getRepoCollaborators,
    addAssignees,
    removeAssignees,
    getRepoLabels,
    addLabels,
    removeLabel,
    convertToDraft,
    markReadyForReview,
    updateBranch,
    closePR,
    reopenPR,
    updatePR,
    getRepoBranches,
    deleteBranch,
    restoreBranch,
    // Reactions
    getIssueReactions,
    addIssueReaction,
    deleteIssueReaction,
    getCommentReactions,
    addCommentReaction,
    deleteCommentReaction,
    // Review comment reactions
    getReviewCommentReactions,
    addReviewCommentReaction,
    deleteReviewCommentReaction,
    // GraphQL
    graphql,
    getPREnrichment,
    getReviewThreads,
    resolveThread,
    unresolveThread,
    getPendingReview,
    addPendingComment,
    deletePendingComment,
    updatePendingComment,
    submitPendingReview,
    // Review reactions
    getReviewReactions,
    addReviewReaction,
    deleteReviewReaction,
    updateComment,
    deleteComment,
    updateIssueComment,
    deleteIssueComment,
    getUserProfile,
    invalidatePR,
  };
}

// ============================================================================
// Context
// ============================================================================

export type GitHubStore = ReturnType<typeof createGitHubStore>;

const GitHubContext = createContext<GitHubStore | null>(null);

// ============================================================================
// Provider
// ============================================================================

export function GitHubProvider({ children }: { children: ReactNode }) {
  const {
    token,
    isAuthenticated,
    logout,
    setRateLimited,
    refreshAccessToken,
    authFlow,
  } = useAuth();
  const storeRef = useRef<GitHubStore | null>(null);

  if (!storeRef.current) {
    storeRef.current = createGitHubStore();
  }

  const store = storeRef.current;

  // Set up unauthorized handler: try refresh for web flow before logging out
  useEffect(() => {
    store.setOnUnauthorized(async () => {
      if (authFlow === "web") {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          const { getEffectiveToken } = await import("./auth");
          const newToken = getEffectiveToken();
          if (newToken) store.initialize(newToken);
          return;
        }
      }
      logout();
    });
  }, [store, logout, refreshAccessToken, authFlow]);

  // Set up rate limit handler
  useEffect(() => {
    store.setOnRateLimited(() => setRateLimited(true));
  }, [store, setRateLimited]);

  useEffect(() => {
    if (isAuthenticated && token) {
      store.initialize(token);
    } else {
      store.reset();
    }
  }, [store, token, isAuthenticated]);

  // Auto-refresh PR list every 60 seconds (React Query handles this via staleTime + refetchOnWindowFocus)
  // The prList query is managed by React Query; no manual interval needed here.

  // Auto-refresh PR checks every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      if (store.getState().ready) {
        store.refreshAllPRChecks();
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [store]);

  return (
    <GitHubContext.Provider value={store}>{children}</GitHubContext.Provider>
  );
}

// ============================================================================
// Hooks
// ============================================================================

export function useGitHubStore() {
  const store = useContext(GitHubContext);
  if (!store) {
    throw new Error("useGitHubStore must be used within GitHubProvider");
  }
  return store;
}

export function useGitHubSelector<T>(selector: (state: GitHubState) => T): T {
  const store = useGitHubStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState())
  );
}

// Convenience hooks
export function useGitHubReady() {
  const ready = useGitHubSelector((s) => s.ready);
  const error = useGitHubSelector((s) => s.error);
  return { ready, error };
}

export function useCurrentUser(): CurrentUserData | null {
  const { ready } = useGitHubReady();
  const { data } = useQuery({ ...queries.currentUser(), enabled: ready });
  return data ?? null;
}

export function usePRChecks(owner: string, repo: string, number: number) {
  const store = useGitHubStore();
  const ready = useGitHubSelector((s) => s.ready);
  const key = store.getPRCheckKey(owner, repo, number);
  const checkState = useGitHubSelector((s) => s.prChecks.get(key));

  useEffect(() => {
    if (ready && !checkState?.lastFetchedAt) {
      store.fetchPRChecks(owner, repo, number);
    }
  }, [ready, store, owner, repo, number, checkState?.lastFetchedAt]);

  return {
    status: checkState?.status || null,
    loading: checkState?.loading || false,
    refresh: () => store.fetchPRChecks(owner, repo, number),
  };
}

export function useRefreshAll() {
  const store = useGitHubStore();
  return useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["pr-list"] });
    store.refreshAllPRChecks();
  }, [store]);
}

/**
 * Hook that throws if GitHub is not ready.
 * Use in components that require GitHub to be available.
 */
export function useGitHub(): GitHubStore {
  const store = useGitHubStore();
  const { ready, error } = useGitHubReady();

  if (error) {
    throw new Error(error);
  }

  if (!ready) {
    throw new Error("GitHub client not ready");
  }

  return store;
}

// Legacy compatibility - type alias
export type GitHubClient = GitHubStore;
