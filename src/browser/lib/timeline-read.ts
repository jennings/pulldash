import type { OverviewTimelineEntry } from "./overview-timeline";

export interface TimelineComment {
  id: string;
  threadId?: string;
  reply?: boolean;
  updatedAt: string;
  author: string | null;
}

export interface TimelineReadState {
  baseline: string | null;
  seen: Record<string, string>;
}

const storageKey = (prId: string) => `pulldash_timeline_read:${prId}`;

export function initializeTimelineReadState(
  prId: string,
  baseline: string | null,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage
): TimelineReadState {
  try {
    const stored = storage.getItem(storageKey(prId));
    if (stored) {
      const parsed = JSON.parse(stored) as TimelineReadState;
      if (
        (parsed.baseline === null || typeof parsed.baseline === "string") &&
        parsed.seen &&
        typeof parsed.seen === "object" &&
        !Array.isArray(parsed.seen) &&
        Object.values(parsed.seen).every((value) => typeof value === "string")
      )
        return parsed;
    }
  } catch {}
  const state = { baseline, seen: {} };
  saveTimelineReadState(prId, state, storage);
  return state;
}

export function saveTimelineReadState(
  prId: string,
  state: TimelineReadState,
  storage: Pick<Storage, "setItem"> = localStorage
) {
  try {
    storage.setItem(storageKey(prId), JSON.stringify(state));
  } catch {}
}

export function getTimelineComments(
  entries: OverviewTimelineEntry[]
): TimelineComment[] {
  const comments: TimelineComment[] = [];
  const addThread = (
    thread: Extract<OverviewTimelineEntry, { type: "thread" }>["data"]
  ) => {
    thread.comments.nodes.forEach((comment, index) => {
      comments.push({
        id: `discussion_r${comment.databaseId}`,
        threadId: `reviewthread-${thread.id}`,
        reply: index > 0,
        updatedAt: comment.updatedAt || comment.createdAt,
        author: comment.author?.login ?? null,
      });
    });
  };
  for (const entry of entries) {
    if (entry.type === "comment" && entry.data.user) {
      comments.push({
        id: `issuecomment-${entry.data.id}`,
        updatedAt: entry.data.updated_at || entry.data.created_at,
        author: entry.data.user?.login ?? null,
      });
    } else if (entry.type === "review") {
      if (entry.data.user && entry.data.body?.trim()) {
        comments.push({
          id: `pullrequestreview-${entry.data.id}`,
          updatedAt: entry.data.submitted_at ?? "",
          author: entry.data.user?.login ?? null,
        });
      }
      entry.threads.forEach(addThread);
    } else if (entry.type === "thread") {
      addThread(entry.data);
    }
  }
  return [
    ...new Map(
      comments.filter((c) => c.updatedAt).map((c) => [c.id, c])
    ).values(),
  ];
}

export function getUnreadTimelineComments(
  comments: TimelineComment[],
  state: TimelineReadState,
  currentUser: string | null
) {
  return comments.filter(
    (comment) =>
      !(
        currentUser &&
        comment.author?.toLowerCase() === currentUser.toLowerCase()
      ) &&
      state.seen[comment.id] !== comment.updatedAt &&
      !(
        state.baseline &&
        Date.parse(comment.updatedAt) <= Date.parse(state.baseline)
      )
  );
}

export function markTimelineCommentsRead(
  state: TimelineReadState,
  comments: TimelineComment[]
): TimelineReadState {
  const changed = comments.filter(
    (comment) => state.seen[comment.id] !== comment.updatedAt
  );
  return changed.length
    ? {
        ...state,
        seen: {
          ...state.seen,
          ...Object.fromEntries(
            changed.map((comment) => [comment.id, comment.updatedAt])
          ),
        },
      }
    : state;
}

export function nextUnreadTimelineComment(
  comments: TimelineComment[],
  unreadIds: ReadonlySet<string>,
  afterId: string | null
) {
  const index = comments.findIndex((comment) => comment.id === afterId);
  return (
    comments.slice(index + 1).find((comment) => unreadIds.has(comment.id)) ??
    comments.find((comment) => unreadIds.has(comment.id))
  );
}

export function observeUnreadTimelineComments(
  root: HTMLElement,
  commentsById: ReadonlyMap<string, TimelineComment>,
  getUnreadIds: () => ReadonlySet<string>,
  onRead: (comments: TimelineComment[]) => void
) {
  const doc = root.ownerDocument;
  const observer = new IntersectionObserver(
    (entries) => {
      if (doc.visibilityState === "hidden") return;
      const reached: TimelineComment[] = [];
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.intersectionRatio < 0.75) continue;
        const id = entry.target.getAttribute("data-timeline-unread");
        const comment = id ? commentsById.get(id) : undefined;
        if (comment && getUnreadIds().has(comment.id)) reached.push(comment);
        observer.unobserve(entry.target);
      }
      if (reached.length) onRead(reached);
    },
    { root, rootMargin: "-56px 0px 0px 0px", threshold: 0.75 }
  );
  let observed = new WeakSet<Element>();
  const observeTargets = () => {
    for (const element of root.querySelectorAll("[data-timeline-unread]")) {
      const id = element.getAttribute("data-timeline-unread");
      if (observed.has(element) || !id || !getUnreadIds().has(id)) continue;
      observed.add(element);
      observer.observe(element);
    }
  };
  observeTargets();
  const mutations = new MutationObserver(observeTargets);
  mutations.observe(root, { childList: true, subtree: true });
  const onVisibility = () => {
    if (doc.visibilityState === "hidden") return;
    observer.disconnect();
    observed = new WeakSet();
    observeTargets();
  };
  doc.addEventListener("visibilitychange", onVisibility);
  return () => {
    observer.disconnect();
    mutations.disconnect();
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
