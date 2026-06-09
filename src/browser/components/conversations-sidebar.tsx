import { memo, useCallback } from "react";
import { SlidersHorizontal } from "lucide-react";
import { cn } from "../cn";
import {
  usePRReviewSelector,
  usePRReviewStore,
  getTimeAgo,
} from "../contexts/pr-review";
import type { ReviewThread } from "../contexts/github";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

// ============================================================================
// Filter helpers
// ============================================================================

function isOutdated(thread: ReviewThread): boolean {
  return thread.isOutdated;
}

function applyFilters(
  threads: ReviewThread[],
  filters: { showResolved: boolean; showOutdated: boolean }
): ReviewThread[] {
  return threads.filter((t) => {
    if (t.isResolved && !filters.showResolved) return false;
    if (isOutdated(t) && !filters.showOutdated) return false;
    return true;
  });
}

// ============================================================================
// ConversationsSidebar
// ============================================================================

export const ConversationsSidebar = memo(function ConversationsSidebar() {
  const store = usePRReviewStore();
  const reviewThreads = usePRReviewSelector((s) => s.reviewThreads);
  const filters = usePRReviewSelector((s) => s.conversationsFilters);
  const prUrl = usePRReviewSelector((s) => s.pr.html_url);

  const visibleThreads = applyFilters(reviewThreads, filters);

  // Are any filters non-default? (showResolved=false, showOutdated=true are defaults)
  const filtersActive = filters.showResolved || !filters.showOutdated;

  const handleClickThread = useCallback(
    (firstCommentId: number, path: string) => {
      store.selectFile(path);
      store.setConversationScrollTarget(firstCommentId);
    },
    [store]
  );

  return (
    <div className="w-72 shrink-0 border-l border-border flex flex-col overflow-hidden">
      {/* Header with filter button */}
      <div className="shrink-0 px-3 py-2 border-b border-border bg-muted/30 flex items-center gap-2">
        <span className="text-sm font-medium flex-1">Conversations</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "p-1 rounded transition-colors",
                filtersActive
                  ? "text-blue-400 bg-blue-500/10"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
              title="Filter conversations"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuCheckboxItem
              checked={filters.showResolved}
              onCheckedChange={(v) =>
                store.setConversationsFilter("showResolved", v)
              }
            >
              Show resolved conversations
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={filters.showOutdated}
              onCheckedChange={(v) =>
                store.setConversationsFilter("showOutdated", v)
              }
            >
              Show outdated conversations
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Date shown
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={filters.threadDateMode}
              onValueChange={(v) =>
                store.setConversationsFilter(
                  "threadDateMode",
                  v as "created" | "activity"
                )
              }
            >
              <DropdownMenuRadioItem value="activity">
                Last activity
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="created">
                Created date
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex-1 overflow-y-auto themed-scrollbar">
        {visibleThreads.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground p-4">
            No open conversations.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {visibleThreads.map((thread) => {
              const firstComment = thread.comments.nodes[0];
              if (!firstComment) return null;

              const author = firstComment.author;
              const replyCount = thread.comments.nodes.length - 1;
              const truncatedBody =
                firstComment.body.length > 200
                  ? firstComment.body.slice(0, 200) + "…"
                  : firstComment.body;
              const createdAt = new Date(firstComment.createdAt);
              const latestUpdatedAt = thread.comments.nodes.reduce(
                (latest, c) => {
                  const d = new Date(c.updatedAt ?? c.createdAt);
                  return d > latest ? d : latest;
                },
                new Date(0)
              );
              const displayDate =
                filters.threadDateMode === "created"
                  ? createdAt
                  : latestUpdatedAt;
              const commentUrl = `${prUrl}#discussion_r${firstComment.databaseId}`;

              const threadIsOutdated = isOutdated(thread);

              const seenLogins = new Set<string>();
              const replyAvatars: Array<{ login: string; avatarUrl: string }> =
                [];
              for (const c of thread.comments.nodes.slice(1)) {
                if (c.author && !seenLogins.has(c.author.login)) {
                  seenLogins.add(c.author.login);
                  replyAvatars.push(c.author);
                  if (replyAvatars.length >= 3) break;
                }
              }

              return (
                <li
                  key={thread.id}
                  className="p-3 hover:bg-muted/30 transition-colors cursor-pointer"
                  onClick={() =>
                    handleClickThread(
                      firstComment.databaseId,
                      firstComment.path
                    )
                  }
                >
                  {/* Author row */}
                  <div className="flex items-center gap-2 mb-1.5">
                    {author ? (
                      <img
                        src={author.avatarUrl}
                        alt={author.login}
                        className="w-5 h-5 rounded-full shrink-0"
                      />
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-muted shrink-0" />
                    )}
                    <span className="text-xs font-medium truncate">
                      {author?.login ?? "Unknown"}
                    </span>
                    <div className="ml-auto flex items-center gap-1 shrink-0">
                      {thread.isResolved && (
                        <span className="px-1.5 py-0.5 text-[10px] rounded-full font-medium bg-green-500/20 text-green-400">
                          Resolved
                        </span>
                      )}
                      {threadIsOutdated && (
                        <span className="px-1.5 py-0.5 text-[10px] rounded-full font-medium bg-amber-500/20 text-amber-400">
                          Outdated
                        </span>
                      )}
                      <a
                        href={commentUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {getTimeAgo(displayDate)}
                      </a>
                    </div>
                  </div>

                  {/* File path */}
                  <p className="text-xs text-muted-foreground font-mono truncate mb-1.5">
                    {firstComment.path}
                  </p>

                  {/* First comment body */}
                  <p
                    className={cn(
                      "text-xs text-foreground/80 mb-2",
                      "line-clamp-3 whitespace-pre-wrap break-words"
                    )}
                  >
                    {truncatedBody}
                  </p>

                  {/* Footer: reply avatars + reply count */}
                  <div className="flex items-center gap-1.5">
                    {replyCount > 0 && (
                      <div className="flex items-center">
                        {replyAvatars.map((user, i) => (
                          <img
                            key={user.login}
                            src={user.avatarUrl}
                            alt={user.login}
                            className="w-4 h-4 rounded-full ring-1 ring-background"
                            style={{ marginLeft: i > 0 ? "-4px" : "0" }}
                          />
                        ))}
                      </div>
                    )}
                    <span className="text-xs text-blue-400">
                      {replyCount === 0
                        ? "No replies"
                        : replyCount === 1
                          ? "1 reply"
                          : `${replyCount} replies`}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
});

// ============================================================================
// useConversationsSidebarCount — visible thread count for the badge
// ============================================================================

export function useConversationsSidebarCount(): number {
  return usePRReviewSelector(
    (s) => applyFilters(s.reviewThreads, s.conversationsFilters).length
  );
}
