import { useState, useCallback, type ReactNode } from "react";
import { CircleDot, GitMerge, GitPullRequest } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card";
import { useGitHubStore, useGitHubSelector } from "../contexts/github";
import { Skeleton } from "./skeleton";
import { cn } from "../cn";
import type { components } from "@octokit/openapi-types";

type IssueData = components["schemas"]["issue"];

// ============================================================================
// Issue/PR Hover Card Component
// ============================================================================

interface IssueHoverCardProps {
  owner: string;
  repo: string;
  number: number;
  /** The trigger element (what the user hovers over) */
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

export function IssueHoverCard({
  owner,
  repo,
  number,
  children,
  side = "bottom",
  align = "start",
}: IssueHoverCardProps) {
  const github = useGitHubStore();
  const ready = useGitHubSelector((s) => s.ready);
  const [issue, setIssue] = useState<IssueData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchIssue = useCallback(async () => {
    if (!ready || issue || loading) return;
    setLoading(true);
    setError(null);
    try {
      const data = await github.getIssueOverview(owner, repo, number);
      setIssue(data);
    } catch (e) {
      setError("Failed to load overview");
      console.error("Failed to fetch issue overview:", e);
    } finally {
      setLoading(false);
    }
  }, [github, ready, owner, repo, number, issue, loading]);

  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild onMouseEnter={fetchIssue}>
        {children}
      </HoverCardTrigger>
      <HoverCardContent side={side} align={align} className="w-80">
        {error ? (
          <div className="text-sm text-muted-foreground">{error}</div>
        ) : issue ? (
          <IssueHoverCardContent issue={issue} />
        ) : (
          <IssueHoverCardSkeleton number={number} />
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

// ============================================================================
// Content Component
// ============================================================================

type IssueState = "OPEN" | "CLOSED" | "MERGED";

function resolveState(issue: IssueData): { isPr: boolean; state: IssueState } {
  const isPr = "pull_request" in issue && issue.pull_request != null;
  if (isPr) {
    const merged = (issue.pull_request as { merged_at?: string | null })
      ?.merged_at;
    return {
      isPr,
      state: merged ? "MERGED" : issue.state === "open" ? "OPEN" : "CLOSED",
    };
  }
  return { isPr, state: issue.state === "open" ? "OPEN" : "CLOSED" };
}

function IssueHoverCardContent({ issue }: { issue: IssueData }) {
  const { isPr, state } = resolveState(issue);
  const Icon = isPr
    ? state === "MERGED"
      ? GitMerge
      : GitPullRequest
    : CircleDot;
  const iconColor =
    isPr && state === "MERGED"
      ? "text-purple-500"
      : state === "OPEN"
        ? "text-green-500"
        : "text-red-500";
  const stateLabel =
    state === "MERGED" ? "Merged" : state === "OPEN" ? "Open" : "Closed";

  const excerpt = issue.body
    ? issue.body.replace(/\r\n/g, "\n").slice(0, 280) +
      (issue.body.length > 280 ? "…" : "")
    : null;

  const labels = (issue.labels ?? []).slice(0, 4);

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5">
        <Icon className={cn("w-4 h-4 mt-1 shrink-0", iconColor)} />
        <div className="flex-1 min-w-0">
          <a
            href={issue.html_url}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-foreground hover:text-blue-400 hover:underline"
          >
            {issue.title}
          </a>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono">#{issue.number}</span>
            <span
              className={cn(
                "text-xs font-medium",
                state === "OPEN" && "text-green-500",
                state === "MERGED" && "text-purple-500",
                state === "CLOSED" && "text-red-500"
              )}
            >
              {stateLabel}
            </span>
          </div>
        </div>
      </div>

      {excerpt && (
        <p className="text-sm text-muted-foreground line-clamp-4 whitespace-pre-wrap break-words">
          {excerpt}
        </p>
      )}

      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {labels.map((label, i) => {
            // The issues endpoint may return labels as plain strings.
            const name = typeof label === "string" ? label : (label.name ?? "");
            const color =
              typeof label === "object" && label.color ? label.color : "8b949e";
            return (
              <span
                key={i}
                className="px-1.5 py-0.5 text-xs rounded-full border"
                style={{ color: `#${color}`, borderColor: `#${color}55` }}
              >
                {name}
              </span>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2 text-sm text-muted-foreground pt-1">
        {issue.user && (
          <img
            src={issue.user.avatar_url}
            alt={issue.user.login}
            className="w-5 h-5 rounded-full"
          />
        )}
        <span>
          {issue.user?.login ?? "ghost"} {resolveKindLabel(issue)}{" "}
          {formatDate(issue.created_at)}
        </span>
      </div>
    </div>
  );
}

function resolveKindLabel(issue: IssueData): string {
  return "pull_request" in issue && issue.pull_request != null
    ? "opened this pull request"
    : "opened this issue";
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// ============================================================================
// Skeleton Component
// ============================================================================

function IssueHoverCardSkeleton({ number }: { number: number }) {
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5">
        <Skeleton className="w-4 h-4 mt-1" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-full" />
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground font-mono">#{number}</span>
            <Skeleton className="h-4 w-16" />
          </div>
        </div>
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
      <div className="space-y-1.5 pt-1">
        <Skeleton className="h-4 w-40" />
      </div>
    </div>
  );
}
