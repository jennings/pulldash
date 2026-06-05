import { memo, useCallback } from "react";
import { cn } from "../cn";
import {
  usePRReviewSelector,
  usePRReviewStore,
  getTimeAgo,
} from "../contexts/pr-review";

// ============================================================================
// ConversationsSidebar
// ============================================================================

export const ConversationsSidebar = memo(function ConversationsSidebar() {
  const store = usePRReviewStore();
  const reviewThreads = usePRReviewSelector((s) => s.reviewThreads);

  // Hardcoded filter: hide resolved, include outdated
  const visibleThreads = reviewThreads.filter((t) => !t.isResolved);

  const handleClickThread = useCallback(
    (firstCommentId: number, path: string) => {
      store.selectFile(path);
      store.setConversationScrollTarget(firstCommentId);
    },
    [store]
  );

  return (
    <div className="w-72 shrink-0 border-l border-border flex flex-col overflow-hidden">
      <div className="shrink-0 px-3 py-2 border-b border-border bg-muted/30">
        <span className="text-sm font-medium">Conversations</span>
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

              return (
                <li key={thread.id} className="p-3 hover:bg-muted/30 transition-colors">
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
                    <span className="text-xs text-muted-foreground ml-auto shrink-0">
                      {getTimeAgo(createdAt)}
                    </span>
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
                      handleClickThread(firstComment.databaseId, firstComment.path)
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
// ConversationsSidebarToggle — count of visible threads for the badge
// ============================================================================

export function useConversationsSidebarCount(): number {
  return usePRReviewSelector(
    (s) => s.reviewThreads.filter((t) => !t.isResolved).length
  );
}
