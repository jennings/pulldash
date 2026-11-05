// Pure builders for the diff viewer's line annotations: where review threads,
// pending comments and the comment composer go in a diff, and which lines
// carry comment decorations. Pierre renders each annotation as a slot below
// its line; the viewer fills the slot with the React comment UI.

import type { AnnotationSide, DiffLineAnnotation } from "@pierre/diffs";
import type { ReviewComment } from "@/api/types";
import { parseOutOfDiffMarker, type OutOfDiffInfo } from "@/shared/out-of-diff";
import type { LocalPendingComment } from "../../contexts/pr-review";
import { groupCommentsByLineSide } from "../../lib/reviews";
import { toPierreSide, type LineSide } from "./selection";

/**
 * Annotation payload. It only identifies *what* goes where (so the item is
 * not rebuilt when a comment's text changes); the viewer looks the live data
 * up by `key`.
 */
export interface AnnotationMeta {
  kind: "thread" | "file-thread" | "pending" | "composer" | "fold";
  /** Identifies the content (see `CommentLayout`); stable across edits. */
  key: string;
  /** `fold` only: the line whose comments the toggle shows or hides. */
  line?: number;
  /** `fold` only: the line's comments are currently shown (unfolded). */
  expanded?: boolean;
  /** `fold` only: how many comments the line has. */
  count?: number;
}

export type ViewerAnnotation = DiffLineAnnotation<AnnotationMeta>;

export interface LineThread {
  key: string;
  line: number;
  side: LineSide;
  comments: ReviewComment[];
}

export interface LinePending {
  key: string;
  line: number;
  side: LineSide;
  comment: LocalPendingComment;
}

export interface CommentLayout {
  /** Threads anchored to a line of the viewed diff. */
  threads: LineThread[];
  /** File-level threads: shown above the first line. */
  fileThreads: Array<{ key: string; comments: ReviewComment[] }>;
  pending: LinePending[];
  /** `"line:side"` of every line a comment (or pending comment) is on. */
  anchorLines: ReadonlySet<string>;
  /** `"line:side"` of every line covered by a comment's line range. */
  rangeLines: ReadonlySet<string>;
  threadsByKey: ReadonlyMap<string, ReviewComment[]>;
  pendingByKey: ReadonlyMap<string, LocalPendingComment>;
}

export interface CommentLayoutInput {
  comments: readonly ReviewComment[];
  pendingComments: readonly LocalPendingComment[];
  /** Commit whose line numbers the diff is in. */
  viewedCommitSha: string;
  /**
   * The line of the viewed diff a (non-file-level) comment belongs to, after
   * re-anchoring across commits; null when it has no place in this diff.
   */
  resolveLine: (comment: ReviewComment) => number | null;
}

const sideOf = (side: string | null | undefined): LineSide =>
  side === "LEFT" ? "old" : "new";

/**
 * Group a file's comments into threads placed on lines of the viewed diff.
 *
 * - File-level comments (`subject_type: "file"`) belong above the diff, except
 *   pulldash's out-of-diff comments, which carry their real position in a
 *   marker (replies inherit it) and render at it while that commit is viewed.
 * - Other comments sit on the line `resolveLine` finds for them.
 * - A thread is shown once, at its first line, even if replies re-anchor
 *   elsewhere.
 */
export function buildCommentLayout({
  comments,
  pendingComments,
  viewedCommitSha,
  resolveLine,
}: CommentLayoutInput): CommentLayout {
  const markers = new Map<number, OutOfDiffInfo>();
  for (const comment of comments) {
    if (comment.subject_type !== "file" || comment.in_reply_to_id) continue;
    const info = parseOutOfDiffMarker(comment.body);
    if (info) markers.set(comment.id, info);
  }

  const byLine = new Map<number, ReviewComment[]>();
  for (const comment of comments) {
    if (comment.subject_type === "file") {
      const info =
        markers.get(comment.id) ??
        (comment.in_reply_to_id
          ? markers.get(comment.in_reply_to_id)
          : undefined);
      if (!info) continue;
      // Marker lines are in the comment's commit coordinates; only anchor
      // while that commit is being viewed.
      if (
        (comment.commit_id ?? "").slice(0, 7) !== viewedCommitSha.slice(0, 7)
      ) {
        continue;
      }
      // Shim the marker's position onto the comment so ranges and sides all
      // use the real anchoring.
      const placed = {
        ...comment,
        line: info.line,
        start_line: info.startLine,
        side: info.side,
      };
      const list = byLine.get(info.line) ?? [];
      list.push(placed);
      byLine.set(info.line, list);
      continue;
    }
    const line = resolveLine(comment);
    if (line) {
      const list = byLine.get(line) ?? [];
      list.push(comment);
      byLine.set(line, list);
    }
  }

  const threadsByKey = new Map<string, ReviewComment[]>();
  const placedThreadIds = new Set<string>();

  const fileRoots = new Map<number, ReviewComment[]>();
  for (const comment of comments) {
    if (comment.subject_type !== "file") continue;
    if (markers.has(comment.id)) continue;
    if (comment.in_reply_to_id && markers.has(comment.in_reply_to_id)) continue;
    if (!comment.in_reply_to_id) fileRoots.set(comment.id, [comment]);
  }
  for (const comment of comments) {
    if (comment.subject_type !== "file" || !comment.in_reply_to_id) continue;
    fileRoots.get(comment.in_reply_to_id)?.push(comment);
  }
  const fileThreads = [...fileRoots.values()].map((thread) => {
    const threadId = thread[0]?.pull_request_review_thread_id;
    if (threadId) placedThreadIds.add(threadId);
    const key = `file:${thread[0].id}`;
    threadsByKey.set(key, thread);
    return { key, comments: thread };
  });

  const threads: LineThread[] = [];
  for (const line of [...byLine.keys()].sort((a, b) => a - b)) {
    const lineComments = byLine.get(line) ?? [];
    const roots = new Map<number, ReviewComment[]>();
    for (const comment of lineComments) {
      if (!comment.in_reply_to_id) roots.set(comment.id, [comment]);
    }
    for (const comment of lineComments) {
      if (comment.in_reply_to_id)
        roots.get(comment.in_reply_to_id)?.push(comment);
    }
    for (const thread of roots.values()) {
      const threadId = thread[0]?.pull_request_review_thread_id;
      if (threadId && placedThreadIds.has(threadId)) continue;
      if (threadId) placedThreadIds.add(threadId);
      const key = `thread:${thread[0].id}`;
      threadsByKey.set(key, thread);
      threads.push({
        key,
        line,
        side: sideOf(thread[0].side),
        comments: thread,
      });
    }
  }

  const pendingByLineSide = groupCommentsByLineSide([...pendingComments]);
  const pendingByKey = new Map<string, LocalPendingComment>();
  const pending: LinePending[] = [];
  for (const [lineSide, list] of pendingByLineSide) {
    const [line, side] = lineSide.split(":");
    for (const comment of list) {
      const key = `pending:${comment.id}`;
      pendingByKey.set(key, comment);
      pending.push({
        key,
        line: Number(line),
        side: side as LineSide,
        comment,
      });
    }
  }

  const anchorLines = new Set<string>();
  const rangeLines = new Set<string>();
  const addRange = (
    start: number | null | undefined,
    end: number,
    side: LineSide
  ) => {
    if (start && start < end) {
      for (let i = start; i <= end; i++) rangeLines.add(`${i}:${side}`);
    } else {
      rangeLines.add(`${end}:${side}`);
    }
  };
  for (const [line, lineComments] of byLine) {
    for (const comment of lineComments) {
      const side = sideOf(comment.side);
      anchorLines.add(`${line}:${side}`);
      rangeLines.add(`${line}:${side}`);
      // The stored range is only trustworthy while the comment is not
      // re-anchored: `start_line` is in the comment's commit coordinates,
      // `line` in the viewed diff's.
      if (comment.start_line && comment.line === line) {
        addRange(comment.start_line, line, side);
      }
    }
  }
  for (const comment of pendingComments) {
    const side = sideOf(comment.side);
    anchorLines.add(`${comment.line}:${side}`);
    addRange(comment.start_line, comment.line, side);
  }

  return {
    threads,
    fileThreads,
    pending,
    anchorLines,
    rangeLines,
    threadsByKey,
    pendingByKey,
  };
}

export interface AnnotationInput {
  layout: CommentLayout;
  /** Where the inline comment composer is open. */
  composer: { line: number; side: LineSide } | null;
  /** All comments are collapsed (the "hide comments" toggle). */
  commentsHidden: boolean;
  /** With `commentsHidden`: whether this line was individually unfolded. */
  isLineHidden: (line: number) => boolean;
  /** Side file-level annotations attach to (`deletions` for a deleted file). */
  fileSide: AnnotationSide;
}

/**
 * Annotations in Pierre's model.
 *
 * Pierre's React wrapper keys each annotation's slot by its *array index*, and
 * the viewer keys the content by annotation, so an entry that changes index
 * remounts (losing e.g. a comment being edited). The array is therefore
 * ordered by how often entries come and go: file threads, fold toggles,
 * threads, pending comments, and the composer last. Adding or removing the
 * composer never moves another entry, and a new pending comment only moves the
 * composer. Pierre groups by (side, line) and keeps this order within a line,
 * so the composer renders below the threads of its line.
 */
export function buildAnnotations({
  layout,
  composer,
  commentsHidden,
  isLineHidden,
  fileSide,
}: AnnotationInput): ViewerAnnotation[] {
  const annotations: ViewerAnnotation[] = [];
  const push = (side: LineSide, line: number, meta: AnnotationMeta) =>
    annotations.push({
      side: toPierreSide(side),
      lineNumber: line,
      metadata: meta,
    });

  for (const thread of layout.fileThreads) {
    annotations.push({
      side: fileSide,
      lineNumber: 0,
      metadata: { kind: "file-thread", key: thread.key },
    });
  }

  if (commentsHidden) {
    const counts = new Map<string, number>();
    for (const t of layout.threads) {
      const k = `${t.side}:${t.line}`;
      counts.set(k, (counts.get(k) ?? 0) + t.comments.length);
    }
    for (const p of layout.pending) {
      const k = `${p.side}:${p.line}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const [k, count] of counts) {
      const [side, line] = k.split(":");
      push(side as LineSide, Number(line), {
        kind: "fold",
        key: `fold:${k}`,
        line: Number(line),
        expanded: !isLineHidden(Number(line)),
        count,
      });
    }
  }

  for (const t of layout.threads) {
    if (commentsHidden && isLineHidden(t.line)) continue;
    push(t.side, t.line, { kind: "thread", key: t.key });
  }
  for (const p of layout.pending) {
    if (commentsHidden && isLineHidden(p.line)) continue;
    push(p.side, p.line, { kind: "pending", key: p.key });
  }
  if (composer) {
    push(composer.side, composer.line, { kind: "composer", key: "composer" });
  }
  return annotations;
}

function sameMeta(a: AnnotationMeta, b: AnnotationMeta): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.kind === "fold" && b.kind === "fold") {
    return (
      a.expanded === b.expanded && a.count === b.count && a.line === b.line
    );
  }
  return true;
}

/**
 * Pierre re-renders an item when its annotations array changes, so keep the
 * previous array when the new one places the same things in the same spots.
 */
export function stabilizeAnnotations(
  previous: ViewerAnnotation[] | undefined,
  next: ViewerAnnotation[]
): ViewerAnnotation[] {
  if (!previous || previous.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) {
    const a = previous[i];
    const b = next[i];
    if (
      a.side !== b.side ||
      a.lineNumber !== b.lineNumber ||
      !a.metadata ||
      !b.metadata ||
      !sameMeta(a.metadata, b.metadata)
    ) {
      return next;
    }
  }
  return previous;
}
