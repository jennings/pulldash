import { memo, useContext } from "react";
import {
  usePRReviewSelector,
  usePRReviewStore,
} from "../../contexts/pr-review";
import type { AnnotationMeta } from "./annotations";
import {
  CommentThread,
  InlineCommentForm,
  PendingCommentItem,
} from "./comments";
import { CommentLayoutContext } from "./viewer-context";

function FoldToggle({
  line,
  expanded,
  count,
}: {
  line: number;
  expanded: boolean;
  count: number;
}) {
  const store = usePRReviewStore();
  const label = `${expanded ? "Fold" : "Unfold"} comments on line ${line}`;
  return (
    <button
      type="button"
      className="flex h-5 items-center gap-2 px-4 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      aria-label={label}
      aria-expanded={expanded}
      title={label}
      onClick={() => store.toggleLineComments(line)}
    >
      <span className="h-2 w-2 rounded-full bg-blue-500 ring-1 ring-background" />
      {count} {count === 1 ? "comment" : "comments"}
      <span className="opacity-60">{expanded ? "· hide" : "· show"}</span>
    </button>
  );
}

function Composer() {
  const commenting = usePRReviewSelector((s) => s.commentingOnLine);
  if (!commenting) return null;
  return (
    <InlineCommentForm
      key={`${commenting.startLine ?? ""}:${commenting.line}`}
      line={commenting.line}
      startLine={commenting.startLine}
    />
  );
}

function Thread({ threadKey }: { threadKey: string }) {
  const layout = useContext(CommentLayoutContext);
  const focusedCommentId = usePRReviewSelector((s) => s.focusedCommentId);
  const editingCommentId = usePRReviewSelector((s) => s.editingCommentId);
  const replyingToCommentId = usePRReviewSelector((s) => s.replyingToCommentId);
  const comments = layout?.threadsByKey.get(threadKey);
  if (!comments) return null;
  return (
    <CommentThread
      comments={comments}
      focusedCommentId={focusedCommentId}
      editingCommentId={editingCommentId}
      replyingToCommentId={replyingToCommentId}
    />
  );
}

function Pending({ pendingKey }: { pendingKey: string }) {
  const layout = useContext(CommentLayoutContext);
  const focusedId = usePRReviewSelector((s) => s.focusedPendingCommentId);
  const editingId = usePRReviewSelector((s) => s.editingPendingCommentId);
  const comment = layout?.pendingByKey.get(pendingKey);
  if (!comment) return null;
  return (
    <PendingCommentItem
      comment={comment}
      isFocused={focusedId === comment.id}
      isEditing={editingId === comment.id}
    />
  );
}

/** What fills an annotation slot. */
export const AnnotationContent = memo(function AnnotationContent({
  meta,
}: {
  meta: AnnotationMeta;
}) {
  switch (meta.kind) {
    case "composer":
      return <Composer />;
    case "fold":
      return (
        <FoldToggle
          line={meta.line ?? 0}
          expanded={meta.expanded ?? false}
          count={meta.count ?? 0}
        />
      );
    case "thread":
    case "file-thread":
      return <Thread threadKey={meta.key} />;
    case "pending":
      return <Pending pendingKey={meta.key} />;
  }
});
