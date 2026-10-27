import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronDown } from "lucide-react";
import { getLastViewed } from "../lib/waiting-prs";
import {
  getUnreadTimelineComments,
  initializeTimelineReadState,
  markTimelineCommentsRead,
  nextUnreadTimelineComment,
  observeUnreadTimelineComments,
  saveTimelineReadState,
  type TimelineComment,
} from "../lib/timeline-read";

interface UnreadContext {
  unreadIds: ReadonlySet<string>;
  highlightedIds: ReadonlySet<string>;
  counts: ReadonlyMap<string, number>;
  firstNew: ReadonlyMap<string, string>;
  commentsById: ReadonlyMap<string, TimelineComment>;
  next: () => void;
  markAllRead: () => void;
}

const TimelineUnreadContext = createContext<UnreadContext | null>(null);

export function TimelineUnreadProvider({
  prId,
  comments,
  currentUser,
  rootRef,
  active,
  onNavigate,
  children,
}: {
  prId: string;
  comments: TimelineComment[];
  currentUser: string | null;
  rootRef: RefObject<HTMLDivElement | null>;
  active: boolean;
  onNavigate: (comment: TimelineComment) => void;
  children: ReactNode;
}) {
  const [readState, setReadState] = useState(() =>
    initializeTimelineReadState(prId, getLastViewed(prId))
  );
  const unread = useMemo(
    () => getUnreadTimelineComments(comments, readState, currentUser),
    [comments, readState, currentUser]
  );
  const unreadIds = useMemo(() => new Set(unread.map((c) => c.id)), [unread]);
  const unreadRef = useRef(unreadIds);
  unreadRef.current = unreadIds;
  const highlighted = useRef(new Set<string>());
  for (const comment of unread) highlighted.current.add(comment.id);
  for (const comment of comments) {
    if (
      currentUser &&
      comment.author?.toLowerCase() === currentUser.toLowerCase()
    ) {
      highlighted.current.delete(comment.id);
    }
  }
  const lastTarget = useRef<string | null>(null);
  const commentsById = useMemo(
    () => new Map(comments.map((c) => [c.id, c])),
    [comments]
  );
  const counts = new Map<string, number>();
  const firstNew = new Map<string, string>();
  for (const comment of comments) {
    if (!comment.threadId) continue;
    if (unreadIds.has(comment.id)) {
      counts.set(comment.threadId, (counts.get(comment.threadId) ?? 0) + 1);
    }
    if (
      comment.reply &&
      highlighted.current.has(comment.id) &&
      !firstNew.has(comment.threadId)
    ) {
      firstNew.set(comment.threadId, comment.id);
    }
  }

  useEffect(() => saveTimelineReadState(prId, readState), [prId, readState]);

  useEffect(() => {
    const root = rootRef.current;
    if (!active || !root || !currentUser) return;
    return observeUnreadTimelineComments(
      root,
      commentsById,
      () => unreadRef.current,
      (reached) =>
        setReadState((state) => markTimelineCommentsRead(state, reached))
    );
  }, [active, rootRef, commentsById, currentUser]);

  return (
    <TimelineUnreadContext.Provider
      value={{
        unreadIds,
        highlightedIds: highlighted.current,
        counts,
        firstNew,
        commentsById,
        next: () => {
          const target = nextUnreadTimelineComment(
            comments,
            unreadIds,
            lastTarget.current
          );
          if (!target) return;
          lastTarget.current = target.id;
          onNavigate(target);
        },
        markAllRead: () => {
          highlighted.current.clear();
          setReadState((state) => markTimelineCommentsRead(state, comments));
        },
      }}
    >
      {children}
    </TimelineUnreadContext.Provider>
  );
}

export function TimelineUnreadControls() {
  const unread = useContext(TimelineUnreadContext);
  if (!unread || unread.commentsById.size === 0) return null;
  const count = unread.unreadIds.size;
  return (
    <div className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-md border border-border bg-background/95 px-3 py-2 text-sm shadow-sm">
      <span className="text-muted-foreground" aria-live="polite">
        {count} unread
      </span>
      <button
        onClick={unread.next}
        disabled={!count}
        className="flex items-center gap-1 font-medium text-blue-500 hover:text-blue-400 disabled:opacity-40"
      >
        Next unread <ChevronDown className="w-4 h-4" />
      </button>
      <button
        onClick={unread.markAllRead}
        disabled={!count}
        className="ml-auto text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
      >
        Mark all read
      </button>
    </div>
  );
}

export function TimelineCommentUnreadMarker({ id }: { id: string }) {
  const unread = useContext(TimelineUnreadContext);
  if (!unread?.highlightedIds.has(id)) return null;
  const comment = unread.commentsById.get(id);
  return (
    <div
      data-timeline-unread={id}
      className="mb-2 flex select-none items-center gap-2 rounded bg-blue-500/10 px-2 py-1 text-xs font-medium text-blue-500"
    >
      {comment?.reply
        ? unread.firstNew.get(comment.threadId!) === id
          ? "New replies"
          : "New reply"
        : "New comment"}
      <span className="h-px flex-1 bg-blue-500/20" />
    </div>
  );
}

export function TimelineThreadUnreadBadge({ threadId }: { threadId: string }) {
  const unread = useContext(TimelineUnreadContext);
  const count = unread?.counts.get(threadId) ?? 0;
  return count ? (
    <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-500">
      {count} unread
    </span>
  ) : null;
}
