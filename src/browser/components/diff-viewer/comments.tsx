import React, {
  memo,
  useCallback,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Loader2,
  MessageSquare,
  Reply,
  Send,
  X,
  Check,
  Trash2,
  Pencil,
  CheckCircle2,
  Circle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from "lucide-react";
import type { Reaction, ReactionContent } from "../../contexts/github";
import { useGitHubStore, useCurrentUser } from "../../contexts/github";
import type { ReviewComment } from "@/api/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";
import { EmojiReactions } from "../emoji-reactions";
import { cn } from "../../cn";
import { useCanWrite, useAuth } from "../../contexts/auth";
import {
  usePRReviewSelector,
  usePRReviewStore,
  useCommentActions,
  useThreadActions,
  type LocalPendingComment,
} from "../../contexts/pr-review";
import { TimeAgo } from "../../ui/time-ago";
import { useDraft } from "../../hooks/use-draft";
import {
  stripCommitMetadataPrefix,
  isMetadataComment,
} from "../../../shared/commit-metadata";
import { stripReviewGroupMarker } from "../../../shared/review-group";
import {
  isOutOfDiffComment,
  rebuildOutOfDiffBody,
  stripOutOfDiffBody,
  stripOutOfDiffPermalink,
  stripOutOfDiffPermalinkHtml,
} from "../../../shared/out-of-diff";
import { Markdown, MarkdownEditor } from "../../ui/markdown";
import { UserHoverCard } from "../../ui/user-hover-card";
import { newSideLines } from "./selection";
import { DiffRowsContext } from "./viewer-context";

// ============================================================================
// Inline Comment Form
// ============================================================================

interface InlineCommentFormProps {
  line: number;
  startLine?: number;
}

export const InlineCommentForm = memo(function InlineCommentForm({
  line,
  startLine,
}: InlineCommentFormProps) {
  const store = usePRReviewStore();
  const canWrite = useCanWrite();
  const currentUser = useCurrentUser();
  const { startDeviceAuth } = useAuth();
  const { addPendingComment } = useCommentActions();
  const rows = useContext(DiffRowsContext);

  const selectedFile = usePRReviewSelector((s) => s.selectedFile);

  const draftKey = `${selectedFile ?? ""}:${line}:${startLine ?? ""}`;
  const [text, setText] = useState(
    () => store.getSnapshot().commentDrafts[draftKey] ?? ""
  );
  const textRef = useRef(text);
  textRef.current = text;

  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  // Make sure the freshly opened form is fully visible with the smallest
  // possible scroll (no re-centering).
  useEffect(() => {
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({
        block: "nearest",
        behavior: "instant",
      });
    });
    // Only on mount, when the form is opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist draft text when the form unmounts without submitting
  useEffect(() => {
    return () => {
      if (textRef.current.trim()) {
        store.setCommentDraft(draftKey, textRef.current);
      } else {
        store.clearCommentDraft(draftKey);
      }
    };
    // intentionally only runs on unmount — draftKey and store are stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!text.trim()) return;

    setSubmitting(true);
    store.clearCommentDraft(draftKey);
    textRef.current = "";
    try {
      await addPendingComment(line, text.trim(), startLine);
      setText("");
    } finally {
      setSubmitting(false);
    }
  }, [text, line, startLine, addPendingComment, store, draftKey]);

  // Esc just closes the form: the unmount effect persists the draft, so
  // reopening the composer on this line restores the text. Discard is the
  // explicit Cancel/X action.
  const handleClose = useCallback(() => {
    store.cancelCommenting();
  }, [store]);

  const handleDiscard = useCallback(() => {
    store.clearCommentDraft(draftKey);
    textRef.current = "";
    store.cancelCommenting();
  }, [store, draftKey]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    },
    [handleSubmit, handleClose]
  );

  const handleSuggestChange = useCallback(() => {
    if (!rows) return;
    const lines = newSideLines(rows, startLine ?? line, line);
    if (lines.length === 0) return;
    const suggestion = "```suggestion\n" + lines.join("\n") + "\n```\n\n";
    setText((prev) => suggestion + prev);
  }, [rows, line, startLine]);

  const lineLabel = startLine ? `lines ${startLine}-${line}` : `line ${line}`;

  // Show sign-in prompt for read-only users
  if (!canWrite) {
    return (
      <div className="mx-4 my-3 max-w-[912px] rounded-lg border border-amber-500/30 bg-amber-500/5 overflow-hidden shadow-sm">
        <div className="flex items-center justify-between px-4 py-3 border-b border-amber-500/20">
          <div className="flex items-center gap-2.5 text-sm font-medium text-amber-200">
            <MessageSquare className="w-4 h-4 text-amber-400" />
            <span>Comment on {lineLabel}</span>
          </div>
          <button
            onClick={store.cancelCommenting}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted/50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            Sign in to leave comments
          </span>
          <button
            onClick={startDeviceAuth}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors"
          >
            Sign in with GitHub
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={formRef}
      data-inline-comment-form
      className="mx-4 my-3 max-w-[912px] rounded-lg border border-border bg-card overflow-hidden shadow-sm"
      style={{ fontFamily: "var(--font-sans)" }}
    >
      {/* Header with avatar and title */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <div className="flex items-center gap-3">
          {currentUser?.avatar_url ? (
            <img
              src={currentUser.avatar_url}
              alt={currentUser.login}
              className="w-6 h-6 rounded-full ring-1 ring-border hidden sm:block"
            />
          ) : (
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center hidden sm:flex">
              <MessageSquare className="w-3 h-3 text-muted-foreground" />
            </div>
          )}
          <span className="text-sm font-medium text-foreground">
            Add comment on {lineLabel}
          </span>
        </div>
        <button
          onClick={handleClose}
          title="Close (keeps draft)"
          className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded hover:bg-muted/50"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Editor area */}
      <div className="p-3">
        <MarkdownEditor
          value={text}
          onChange={setText}
          onKeyDown={handleKeyDown}
          placeholder="Leave a comment..."
          minHeight="100px"
          autoFocus
          extraToolbarActions={
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleSuggestChange}
                  disabled={!rows}
                  title="Suggest a code change using GitHub suggestion syntax"
                  className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <span className="text-sm font-medium leading-none">±</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Suggest change
              </TooltipContent>
            </Tooltip>
          }
        />
      </div>

      {/* Action buttons */}
      <div
        className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border bg-muted/20"
        style={{ fontFamily: "var(--font-sans)" }}
      >
        <button
          onClick={handleDiscard}
          title="Discard draft"
          className="px-4 py-2 text-sm font-medium rounded-md border border-border bg-background hover:bg-muted transition-colors"
          style={{ fontFamily: "var(--font-sans)" }}
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!text.trim() || submitting}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ fontFamily: "var(--font-sans)" }}
        >
          {submitting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
          Add to review
        </button>
      </div>
    </div>
  );
});

// ============================================================================
// Comment Thread
// ============================================================================

interface CommentThreadProps {
  comments: ReviewComment[];
  focusedCommentId: number | null;
  editingCommentId: number | null;
  replyingToCommentId: number | null;
}

export const CommentThread = memo(function CommentThread({
  comments,
  focusedCommentId,
  editingCommentId,
  replyingToCommentId,
}: CommentThreadProps) {
  const canWrite = useCanWrite();
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const { updateComment, deleteComment } = useCommentActions();
  const { resolveThread, unresolveThread } = useThreadActions();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [resolving, setResolving] = useState(false);

  const replyingTo =
    comments.find((c) => c.id === replyingToCommentId)?.id ?? null;

  // Get resolution info from first comment (all comments in thread share same resolution status)
  const firstComment = comments[0];
  const isResolved = firstComment?.is_resolved ?? false;
  const isOutdated = firstComment?.outdated ?? false;
  const threadId = firstComment?.pull_request_review_thread_id;

  const handleResolve = useCallback(async () => {
    if (!threadId) return;
    setResolving(true);
    try {
      await resolveThread(threadId);
      // Auto-collapse when resolved
      setIsCollapsed(true);
    } finally {
      setResolving(false);
    }
  }, [threadId, resolveThread]);

  const handleUnresolve = useCallback(async () => {
    if (!threadId) return;
    setResolving(true);
    try {
      await unresolveThread(threadId);
      setIsCollapsed(false);
    } finally {
      setResolving(false);
    }
  }, [threadId, unresolveThread]);

  // Auto-collapse resolved threads
  useEffect(() => {
    if (isResolved) {
      setIsCollapsed(true);
    }
  }, [isResolved]);

  const threadAvatars = (() => {
    const seenLogins = new Set<string>();
    const avatars: Array<{ login: string; avatar_url: string }> = [];
    for (const c of comments) {
      if (c.user && !seenLogins.has(c.user.login)) {
        seenLogins.add(c.user.login);
        avatars.push(c.user);
        if (avatars.length >= 3) break;
      }
    }
    return avatars;
  })();

  return (
    <div
      data-comment-thread
      id={firstComment ? `reviewthread-comment-${firstComment.id}` : undefined}
      className={cn(
        "mx-4 my-2 max-w-[912px] rounded-r-lg border-l-2",
        isResolved
          ? "border-green-500/50 bg-green-500/5"
          : "border-blue-500/50 bg-card/80"
      )}
    >
      {/* Thread header with resolve/unresolve */}
      <div
        className={cn(
          "flex items-center justify-between px-4 py-2 border-b border-border/30",
          isResolved && "cursor-pointer select-none"
        )}
        onClick={isResolved ? () => setIsCollapsed(!isCollapsed) : undefined}
      >
        <div className="flex items-center gap-2">
          {isResolved ? (
            <CheckCircle2 className="w-4 h-4 text-green-500" />
          ) : (
            <Circle className="w-4 h-4 text-muted-foreground" />
          )}
          <div className="flex items-center">
            {threadAvatars.map((user, i) => (
              <UserHoverCard
                key={user.login}
                login={user.login}
                side="right"
                align={i === 0 ? "start" : "center"}
              >
                <img
                  src={user.avatar_url}
                  alt={user.login}
                  className="w-4 h-4 rounded-full ring-1 ring-background relative cursor-pointer"
                  style={{
                    marginLeft: i > 0 ? "-4px" : "0",
                    zIndex: threadAvatars.length - i,
                  }}
                />
              </UserHoverCard>
            ))}
          </div>
          <span className="text-xs text-muted-foreground">
            {comments.length === 1
              ? "1 comment"
              : `${comments.length} comments`}
          </span>
          {isResolved && (
            <span className="px-1.5 py-0.5 text-[10px] rounded-full font-medium bg-green-500/20 text-green-400">
              Resolved
            </span>
          )}
          {isOutdated && (
            <span className="px-1.5 py-0.5 text-[10px] rounded-full font-medium bg-amber-500/20 text-amber-400">
              Outdated
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canWrite && threadId && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (isResolved) handleUnresolve();
                else handleResolve();
              }}
              disabled={resolving}
              className={cn(
                "flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors",
                isResolved
                  ? "text-muted-foreground hover:text-foreground hover:bg-muted"
                  : "text-green-500 hover:bg-green-500/10"
              )}
            >
              {resolving ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : isResolved ? (
                <>
                  <Circle className="w-3 h-3" />
                  Unresolve
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-3 h-3" />
                  Resolve
                </>
              )}
            </button>
          )}
          {isResolved && (
            <span className="p-1 text-muted-foreground">
              {isCollapsed ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronUp className="w-4 h-4" />
              )}
            </span>
          )}
        </div>
      </div>

      {/* Comment content (collapsible for resolved) */}
      {!isCollapsed && (
        <>
          {comments.map((comment, idx) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              isReply={idx > 0}
              isFocused={focusedCommentId === comment.id}
              isEditing={editingCommentId === comment.id}
              isResolved={isResolved}
              onUpdate={updateComment}
              onDelete={deleteComment}
              owner={owner}
              repo={repo}
            />
          ))}

          {canWrite && replyingTo && firstComment && (
            <DiffReplyComposer
              key={firstComment.id}
              commentId={firstComment.id}
              replyingTo={replyingTo}
            />
          )}
        </>
      )}
    </div>
  );
});

const DiffReplyComposer = memo(function DiffReplyComposer({
  commentId,
  replyingTo,
}: {
  commentId: number;
  replyingTo: number;
}) {
  const store = usePRReviewStore();
  const { replyToComment } = useCommentActions();
  const saved = usePRReviewSelector((s) => s.replyDrafts[commentId] ?? "");
  const [body, setBody, flush] = useDraft(saved, (value) => {
    if (value.trim()) store.setReplyDraft(commentId, value);
    else store.clearReplyDraft(commentId);
  });
  const [submitting, setSubmitting] = useState(false);
  const submit = async () => {
    if (submitting || !body.trim()) return;
    flush();
    setSubmitting(true);
    try {
      await replyToComment(replyingTo, body.trim());
      setBody("");
      store.clearReplyDraft(commentId);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="px-4 py-3 border-t border-border/50" onBlurCapture={flush}>
      <MarkdownEditor
        value={body}
        onChange={setBody}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            flush();
            store.cancelReplying();
          }
        }}
        placeholder="Write a reply..."
        minHeight="60px"
        autoFocus
        disabled={submitting}
      />
      <div className="flex justify-end gap-2 mt-3">
        <button
          onClick={() => {
            setBody("");
            flush();
            store.cancelReplying();
          }}
          disabled={submitting}
          title="Discard draft"
          className="px-3 py-1.5 text-sm rounded-md hover:bg-muted transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!body.trim() || submitting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          <Send className="w-3.5 h-3.5" />
          Reply
        </button>
      </div>
    </div>
  );
});

// ============================================================================
// Comment Item
// ============================================================================

interface CommentItemProps {
  comment: ReviewComment;
  isReply?: boolean;
  isFocused?: boolean;
  isEditing?: boolean;
  isResolved?: boolean;
  onUpdate: (commentId: number, body: string) => Promise<void>;
  onDelete: (commentId: number) => Promise<void>;
  owner: string;
  repo: string;
}

const CommentItem = memo(function CommentItem({
  comment,
  isReply,
  isFocused,
  isEditing,
  isResolved,
  onUpdate,
  onDelete,
  owner,
  repo,
}: CommentItemProps) {
  const store = usePRReviewStore();
  const github = useGitHubStore();
  const currentUser = usePRReviewSelector((s) => s.currentUser);
  const viewerPermission = usePRReviewSelector((s) => s.viewerPermission);
  const canWrite = useCanWrite();
  const isOwnComment = currentUser === comment.user.login;
  // ADMIN and MAINTAIN can edit/delete any comment, WRITE can only edit own comments
  const canEditComment =
    canWrite &&
    (isOwnComment ||
      viewerPermission === "ADMIN" ||
      viewerPermission === "MAINTAIN");

  // Reactions state
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [loadingReactions, setLoadingReactions] = useState(false);

  // Fetch reactions on mount
  useEffect(() => {
    const fetchReactions = async () => {
      setLoadingReactions(true);
      try {
        const data = await github.getReviewCommentReactions(
          owner,
          repo,
          comment.id
        );
        setReactions(data);
      } catch (error) {
        console.error("Failed to fetch reactions:", error);
      } finally {
        setLoadingReactions(false);
      }
    };
    fetchReactions();
  }, [github, owner, repo, comment.id]);

  const handleAddReaction = useCallback(
    async (content: ReactionContent) => {
      try {
        const newReaction = await github.addReviewCommentReaction(
          owner,
          repo,
          comment.id,
          content
        );
        setReactions((prev) => [...prev, newReaction]);
      } catch (error) {
        console.error("Failed to add reaction:", error);
      }
    },
    [github, owner, repo, comment.id]
  );

  const handleRemoveReaction = useCallback(
    async (reactionId: number) => {
      try {
        await github.deleteReviewCommentReaction(
          owner,
          repo,
          comment.id,
          reactionId
        );
        setReactions((prev) => prev.filter((r) => r.id !== reactionId));
      } catch (error) {
        console.error("Failed to remove reaction:", error);
      }
    },
    [github, owner, repo, comment.id]
  );
  // Editing strips the hidden review-group marker for display; the save
  // re-attaches it (via withReviewGroupMarker in the store action).
  // Out-of-diff comments additionally hide their position marker and blob
  // permalink; the save rebuilds them (rebuildOutOfDiffBody).
  const visibleBody = useMemo(() => {
    if (isOutOfDiffComment(comment.body)) {
      return stripOutOfDiffBody(comment.body);
    }
    return stripReviewGroupMarker(comment.body);
  }, [comment.body]);
  const [editText, setEditText] = useState(visibleBody);
  const [saving, setSaving] = useState(false);
  const commentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isEditing) {
      setEditText(visibleBody);
    }
  }, [isEditing, visibleBody]);

  useEffect(() => {
    if (isFocused && commentRef.current) {
      commentRef.current.scrollIntoView({
        block: "center",
        behavior: "instant",
      });
    }
  }, [isFocused]);

  const handleSave = useCallback(async () => {
    if (!editText.trim() || editText === visibleBody) {
      store.cancelEditing();
      return;
    }
    setSaving(true);
    try {
      await onUpdate(comment.id, editText.trim());
    } finally {
      setSaving(false);
    }
  }, [editText, comment.id, visibleBody, onUpdate, store]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        store.cancelEditing();
      }
    },
    [handleSave, store]
  );

  // Handle click to focus this comment for keyboard navigation
  const handleClick = useCallback(() => {
    if (!isEditing) {
      store.setFocusedCommentId(comment.id);
    }
  }, [store, comment.id, isEditing]);

  return (
    <div
      ref={commentRef}
      onClick={handleClick}
      className={cn(
        "px-4 py-3 font-sans hover:bg-muted/30 transition-colors",
        isReply && "pl-12 border-t border-border/30",
        isFocused && "ring-2 ring-blue-500 ring-inset bg-blue-500/5",
        isResolved && "opacity-75"
      )}
    >
      <div className="flex items-start gap-3">
        <UserHoverCard login={comment.user.login} side="right">
          <img
            src={comment.user.avatar_url}
            alt={comment.user.login}
            className="w-6 h-6 rounded-full shrink-0 cursor-pointer"
            loading="lazy"
          />
        </UserHoverCard>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <UserHoverCard login={comment.user.login} side="right">
              <span className="font-medium cursor-pointer hover:underline">
                {comment.user.login}
              </span>
            </UserHoverCard>
            <a
              href={comment.html_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground text-xs hover:text-foreground hover:underline"
            >
              <TimeAgo date={new Date(comment.created_at)} />
            </a>
          </div>

          {isEditing ? (
            <div className="mt-2">
              <MarkdownEditor
                value={editText}
                onChange={setEditText}
                onKeyDown={handleKeyDown}
                placeholder="Edit your comment..."
                minHeight="60px"
                autoFocus
              />
              <div className="flex justify-end gap-2 mt-3">
                <button
                  onClick={store.cancelEditing}
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
          ) : (
            <>
              <div className="mt-1 text-sm text-foreground/90">
                {isMetadataComment(comment.body) ? (
                  <Markdown>{stripCommitMetadataPrefix(comment.body)}</Markdown>
                ) : isOutOfDiffComment(comment.body) ? (
                  <Markdown
                    html={
                      comment.body_html
                        ? stripOutOfDiffPermalinkHtml(comment.body_html)
                        : undefined
                    }
                  >
                    {stripOutOfDiffPermalink(stripOutOfDiffBody(comment.body))}
                  </Markdown>
                ) : (
                  <Markdown html={comment.body_html}>{comment.body}</Markdown>
                )}
              </div>

              {/* Reactions + Actions footer */}
              <div className="flex items-center gap-1 px-4 py-2 border-t border-border bg-card">
                <EmojiReactions
                  reactions={reactions}
                  onAddReaction={canWrite ? handleAddReaction : undefined}
                  onRemoveReaction={canWrite ? handleRemoveReaction : undefined}
                  currentUser={currentUser}
                  compact
                />
                <div className="ml-auto flex items-center gap-3">
                  <a
                    href={comment.html_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    title="Open in GitHub"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                  {canWrite && (
                    <button
                      onClick={() => store.startReplying(comment.id)}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      title="Reply (r)"
                    >
                      <Reply className="w-3 h-3" />
                      Reply
                      {isFocused && (
                        <kbd className="ml-0.5 px-1 py-0.5 bg-muted/60 rounded text-[9px] font-mono">
                          r
                        </kbd>
                      )}
                    </button>
                  )}
                  {canEditComment && (
                    <>
                      <button
                        onClick={() => store.startEditing(comment.id)}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        title="Edit (e)"
                      >
                        <Pencil className="w-3 h-3" />
                        Edit
                        {isFocused && (
                          <kbd className="ml-0.5 px-1 py-0.5 bg-muted/60 rounded text-[9px] font-mono">
                            e
                          </kbd>
                        )}
                      </button>
                      <button
                        onClick={() => onDelete(comment.id)}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors"
                        title="Delete (d)"
                      >
                        <Trash2 className="w-3 h-3" />
                        Delete
                        {isFocused && (
                          <kbd className="ml-0.5 px-1 py-0.5 bg-muted/60 rounded text-[9px] font-mono">
                            d
                          </kbd>
                        )}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
});

// ============================================================================
// Pending Comment Item
// ============================================================================

interface PendingCommentItemProps {
  comment: LocalPendingComment;
  isFocused?: boolean;
  isEditing?: boolean;
}

export const PendingCommentItem = memo(function PendingCommentItem({
  comment,
  isFocused,
  isEditing,
}: PendingCommentItemProps) {
  const store = usePRReviewStore();
  const { removePendingComment, updatePendingComment } = useCommentActions();
  const currentUser = usePRReviewSelector((s) => s.currentUser);
  const [editText, setEditText] = useState(
    stripCommitMetadataPrefix(comment.body)
  );
  const [saving, setSaving] = useState(false);
  const commentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isEditing) {
      setEditText(comment.body);
    }
  }, [isEditing, comment.body]);

  useEffect(() => {
    if (isFocused && commentRef.current) {
      commentRef.current.scrollIntoView({
        block: "center",
        behavior: "instant",
      });
    }
  }, [isFocused]);

  const handleSave = useCallback(async () => {
    if (!editText.trim() || editText === comment.body) {
      store.cancelEditingPendingComment();
      return;
    }
    setSaving(true);
    try {
      await updatePendingComment(comment.id, editText.trim());
    } finally {
      setSaving(false);
    }
  }, [editText, comment.id, comment.body, updatePendingComment, store]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        store.cancelEditingPendingComment();
      }
    },
    [handleSave, store]
  );

  // Handle click to focus this comment for keyboard navigation
  const handleClick = useCallback(() => {
    if (!isEditing) {
      store.setFocusedPendingCommentId(comment.id);
    }
  }, [store, comment.id, isEditing]);

  return (
    <div
      ref={commentRef}
      data-comment-thread
      className={cn(
        "border-l-2 border-yellow-500 bg-card/80 mx-4 my-2 max-w-[912px] rounded-r-lg",
        isFocused && "ring-2 ring-blue-500 ring-inset"
      )}
    >
      <div
        onClick={handleClick}
        className={cn(
          "px-4 py-3 font-sans hover:bg-muted/30 transition-colors",
          isFocused && "bg-blue-500/5"
        )}
      >
        <div className="flex items-start gap-3">
          <img
            src={`https://avatars.githubusercontent.com/${currentUser || "ghost"}`}
            alt={currentUser || "You"}
            className="w-6 h-6 rounded-full shrink-0"
            loading="lazy"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{currentUser || "You"}</span>
                <span className="text-muted-foreground text-xs">just now</span>
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/20 text-yellow-500 rounded">
                  Pending
                </span>
                {comment.anchoredFrom && (
                  <span className="text-muted-foreground text-xs font-mono">
                    on {comment.anchoredFrom.slice(0, 7)}
                  </span>
                )}
              </div>
            </div>

            {isEditing ? (
              <div className="mt-2">
                <MarkdownEditor
                  value={editText}
                  onChange={setEditText}
                  onKeyDown={handleKeyDown}
                  placeholder="Edit your comment..."
                  minHeight="60px"
                  autoFocus
                />
                <div className="flex justify-end gap-2 mt-3">
                  <button
                    onClick={store.cancelEditingPendingComment}
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
            ) : (
              <>
                <div className="mt-1 text-sm text-foreground/90">
                  <Markdown>{stripCommitMetadataPrefix(comment.body)}</Markdown>
                </div>
                <div className="flex items-center gap-3 mt-2">
                  <button
                    onClick={() => store.startEditingPendingComment(comment.id)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    title="Edit (e)"
                  >
                    <Pencil className="w-3 h-3" />
                    Edit
                    {isFocused && (
                      <kbd className="ml-0.5 px-1 py-0.5 bg-muted/60 rounded text-[9px] font-mono">
                        e
                      </kbd>
                    )}
                  </button>
                  <button
                    onClick={() => removePendingComment(comment.id)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive transition-colors"
                    title="Delete (d)"
                  >
                    <Trash2 className="w-3 h-3" />
                    Delete
                    {isFocused && (
                      <kbd className="ml-0.5 px-1 py-0.5 bg-muted/60 rounded text-[9px] font-mono">
                        d
                      </kbd>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
