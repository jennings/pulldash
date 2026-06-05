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

              const threadIsOutdated = isOutdated(thread);

              return (
                <li
                  key={thread.id}
                  className="p-3 hover:bg-muted/30 transition-colors"
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
                      <span className="text-xs text-muted-foreground">
                        {getTimeAgo(createdAt)}
                      </span>
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

                  {/* Footer link */}
                  <button
                    onClick={() =>
                      handleClickThread(
                        firstComment.databaseId,
                        firstComment.path
                      )
                    }
                    className="text-xs text-blue-400 hover:text-blue-300 hover:underline transition-colors"
                  >
                    {replyCount === 0
                      ? "No replies"
                      : replyCount === 1
                        ? "1 reply"
                        : `${replyCount} replies`}
                  </button>
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
  return usePRReviewSelector((s) =>
    applyFilters(s.reviewThreads, s.conversationsFilters).length
  );
}
