import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  AnnotationSide,
  CodeViewItem,
  CodeViewLineSelection,
  PostRenderPhase,
  SelectedLineRange,
} from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewReactOptions,
  type CodeViewAnnotationArgs,
} from "@pierre/diffs/react";
import {
  areLineCommentsHidden,
  useCurrentFileComments,
  useCurrentFilePendingComments,
  useDiffFilesLoader,
  usePRReviewSelector,
  usePRReviewStore,
  type DiffViewMode,
} from "../../contexts/pr-review";
import { resolveCommentLine } from "../../lib/comment-anchor";
import {
  DIFF_COLLAPSED_CONTEXT_THRESHOLD,
  diffRows,
  type DiffExpansion,
  type LoadedDiff,
} from "../../lib/file-diff";
import {
  DIFF_THEMES,
  isDiffInstance,
  readDiffExpansion,
  useDiffThemeType,
  type DiffInstance,
} from "../../lib/pierre";
import { AnnotationContent } from "./annotation-content";
import {
  buildAnnotations,
  buildCommentLayout,
  stabilizeAnnotations,
  type AnnotationMeta,
  type ViewerAnnotation,
} from "./annotations";
import { STATIC_CSS, buildDecorationCss, draftLinesFor } from "./decorations";
import { useDiffSearch } from "./diff-search";
import { findGap, lineNextToGap, sameExpansion } from "./gaps";
import { SearchHighlighter } from "./search-highlight";
import {
  extendSelection,
  focusToRange,
  fromPierreSide,
  rangeToCommentTarget,
  rangeToFocus,
} from "./selection";
import { useReveal } from "./use-reveal";
import { CommentLayoutContext, DiffRowsContext } from "./viewer-context";

interface DiffViewerProps {
  diff: LoadedDiff;
  /** File `diff` belongs to (the selected file once its diff has loaded). */
  filename: string;
  viewMode: DiffViewMode;
  wordWrap: boolean;
}

type ViewerHandle = CodeViewHandle<AnnotationMeta, undefined>;
type ViewerOptions = CodeViewReactOptions<AnnotationMeta, undefined>;

// Pierre keys its per-item state (layout, expansion, selection) by item id,
// and only re-reads an item when its version changes. A different diff of the
// same file is a different item.
const diffTokens = new WeakMap<object, number>();
let nextDiffToken = 0;
function itemIdFor(filename: string, fileDiff: object): string {
  let token = diffTokens.get(fileDiff);
  if (token === undefined) {
    token = nextDiffToken++;
    diffTokens.set(fileDiff, token);
  }
  return `${filename}#${token}`;
}

// Remembers what was expanded in a diff, to restore it when the diff is shown
// again (Pierre keeps expansion per rendered instance, which is discarded when
// another file is selected).
const expansionMemory = new WeakMap<object, DiffExpansion>();

const SCROLLER_STYLE = {
  touchAction: "pan-y pinch-zoom",
  // Matches Pierre's default virtualization metrics (20px lines).
  "--diffs-line-height": "20px",
  "--diffs-selection-color-override": "rgb(59, 130, 246)",
  "--diffs-bg-selection-override": "rgba(59, 130, 246, 0.14)",
  "--diffs-bg-selection-number-override": "rgba(59, 130, 246, 0.4)",
} as CSSProperties;

function ignoreGutterUtilityClick() {}

const LAYOUT = {
  paddingTop: 16,
  // Room to scroll the last lines to the middle of the viewport.
  paddingBottom: 300,
  gap: 0,
} as const;

/** Renders the open file's diff with Pierre's `CodeView`. */
export const DiffViewer = memo(function DiffViewer({
  diff,
  filename,
  viewMode,
  wordWrap,
}: DiffViewerProps) {
  const store = usePRReviewStore();
  const handleRef = useRef<ViewerHandle>(null);
  const themeType = useDiffThemeType();
  const loadDiffFiles = useDiffFilesLoader(filename);
  const itemId = itemIdFor(filename, diff.fileDiff);

  // -- Rows ------------------------------------------------------------------
  // Pierre owns expansion and hydration. `view` is what it last reported for
  // this item (also sent to the store, which derives navigation from it); the
  // rows here are exactly what it shows.
  const [view, setView] = useState<{
    itemId: string;
    expansion: DiffExpansion;
  } | null>(null);
  const rows = useMemo(
    () =>
      diffRows(
        diff.fileDiff,
        view?.itemId === itemId ? view.expansion : undefined
      ),
    [diff.fileDiff, view, itemId]
  );

  // -- Comments --------------------------------------------------------------
  const comments = useCurrentFileComments();
  const pendingComments = useCurrentFilePendingComments();
  // Comments anchored to any other commit are re-positioned by content
  // instead of using `comment.line` (in the comment's own commit coordinates).
  const viewedCommitSha = usePRReviewSelector(
    (s) => s.selectedCommitSha ?? s.selectedHeadSha ?? s.pr.head.sha
  );
  const layout = useMemo(
    () =>
      buildCommentLayout({
        comments,
        pendingComments,
        viewedCommitSha,
        resolveLine: (comment) =>
          resolveCommentLine(
            {
              commitId: comment.commit_id,
              originalCommitId: comment.original_commit_id,
              line: comment.line,
              originalLine: comment.original_line,
              side: comment.side as "LEFT" | "RIGHT" | null | undefined,
              startLine: comment.start_line,
              diffHunk: comment.diff_hunk,
            },
            viewedCommitSha,
            diff
          ) ?? null,
      }),
    [comments, pendingComments, viewedCommitSha, diff]
  );

  const commentingLine = usePRReviewSelector((s) => s.commentingOnLine?.line);
  const commentingSide = usePRReviewSelector((s) => s.commentingOnLine?.side);
  const commentsHidden = usePRReviewSelector((s) => s.commentsHidden);
  const expandedCommentLines = usePRReviewSelector(
    (s) => s.expandedCommentLines
  );
  const commentDrafts = usePRReviewSelector((s) => s.commentDrafts);

  const annotationsRef = useRef<ViewerAnnotation[]>([]);
  const annotations = useMemo(() => {
    const next = stabilizeAnnotations(
      annotationsRef.current,
      buildAnnotations({
        layout,
        composer:
          commentingLine === undefined
            ? null
            : { line: commentingLine, side: commentingSide ?? "new" },
        commentsHidden,
        isLineHidden: (line) =>
          areLineCommentsHidden(
            { commentsHidden, expandedCommentLines, selectedFile: filename },
            line
          ),
        fileSide: diff.fileDiff.type === "deleted" ? "deletions" : "additions",
      })
    );
    annotationsRef.current = next;
    return next;
  }, [
    layout,
    commentingLine,
    commentingSide,
    commentsHidden,
    expandedCommentLines,
    filename,
    diff.fileDiff.type,
  ]);

  // Pierre re-reads an item when its version changes: bump it with the
  // annotations (the only part of the item that changes in place).
  const versionRef = useRef({ itemId, annotations, version: 0 });
  if (
    versionRef.current.itemId !== itemId ||
    versionRef.current.annotations !== annotations
  ) {
    versionRef.current = {
      itemId,
      annotations,
      version: versionRef.current.version + 1,
    };
  }
  const { version } = versionRef.current;

  const items = useMemo<CodeViewItem<AnnotationMeta>[]>(
    () => [
      {
        id: itemId,
        type: "diff",
        fileDiff: diff.fileDiff,
        annotations,
        version,
      },
    ],
    [itemId, diff.fileDiff, annotations, version]
  );

  // -- Pierre interop: expansion, rendered DOM -------------------------------
  const latest = useRef({ filename, itemId, diff, rows, loadDiffFiles });
  latest.current = { filename, itemId, diff, rows, loadDiffFiles };
  const instanceRef = useRef<DiffInstance | null>(null);
  const highlighter = useMemo(() => new SearchHighlighter(), []);
  useEffect(() => () => highlighter.dispose(), [highlighter]);

  const lastSyncRef = useRef<{
    itemId: string;
    isPartial: boolean;
    expansion: DiffExpansion;
  } | null>(null);
  const replayedRef = useRef<string | null>(null);
  // A new item is a new Pierre instance with nothing expanded, even when it
  // is the same diff as one shown before. (Layout-effect cleanups run before
  // Pierre's first render of the new item, so its report is not lost.)
  useLayoutEffect(
    () => () => {
      lastSyncRef.current = null;
      replayedRef.current = null;
      setView(null);
    },
    [itemId]
  );
  // Tell the store what Pierre shows (expansion + whether the full file was
  // loaded), once per change.
  const syncView = useCallback(
    (instance: DiffInstance) => {
      const { filename, itemId, diff } = latest.current;
      const map = readDiffExpansion(instance);
      const isPartial = diff.fileDiff.isPartial;
      const last = lastSyncRef.current;
      if (
        last?.itemId === itemId &&
        last.isPartial === isPartial &&
        sameExpansion(last.expansion, map)
      ) {
        return;
      }
      const expansion = new Map(map);
      lastSyncRef.current = { itemId, isPartial, expansion };
      expansionMemory.set(diff.fileDiff, expansion);
      store.syncDiffView(filename, expansion);
      setView({ itemId, expansion });
    },
    [store]
  );

  const focusedGapIndex = usePRReviewSelector((s) => s.focusedGapIndex);

  // Constant `unsafeCSS`, and a viewer-owned stylesheet for the rules that
  // follow comment and focus state: changing Pierre's options would make it
  // rebuild its layout.
  const decorationSheet = useMemo(() => new CSSStyleSheet(), []);
  const decorationCss = useMemo(
    () =>
      buildDecorationCss({
        style: viewMode,
        rows,
        rangeLines: layout.rangeLines,
        draftLines: draftLinesFor(commentDrafts, filename),
        focusedGap: focusedGapIndex,
      }),
    [
      viewMode,
      rows,
      layout.rangeLines,
      commentDrafts,
      filename,
      focusedGapIndex,
    ]
  );
  useEffect(
    () => decorationSheet.replaceSync(decorationCss),
    [decorationSheet, decorationCss]
  );

  const onPostRender = useCallback(
    (
      node: HTMLElement,
      instance: object,
      phase: PostRenderPhase,
      context: { item: { id: string } }
    ) => {
      if (!isDiffInstance(instance)) return;
      if (phase === "unmount") {
        if (instanceRef.current === instance) instanceRef.current = null;
        highlighter.detach(node);
        return;
      }
      const { itemId, diff, loadDiffFiles } = latest.current;
      if (context.item.id !== itemId) return;
      instanceRef.current = instance;
      const root = node.shadowRoot;
      if (root && !root.adoptedStyleSheets.includes(decorationSheet)) {
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, decorationSheet];
      }
      highlighter.attach(node);

      // Returning to a diff: Pierre starts a new instance with nothing
      // expanded, so re-apply what was open. The re-render this queues
      // reports the result.
      if (replayedRef.current !== itemId) {
        replayedRef.current = itemId;
        const remembered = expansionMemory.get(diff.fileDiff);
        if (
          remembered &&
          remembered.size > 0 &&
          (!diff.fileDiff.isPartial || loadDiffFiles)
        ) {
          for (const [hunkIndex, region] of remembered) {
            if (region.fromStart > 0) {
              instance.expandHunk(hunkIndex, "up", region.fromStart);
            }
            if (region.fromEnd > 0) {
              instance.expandHunk(hunkIndex, "down", region.fromEnd);
            }
          }
          return;
        }
      }
      syncView(instance);
    },
    [highlighter, syncView, decorationSheet]
  );

  /** Expand the whole collapsed gap before hunk `hunkIndex`. */
  const expandGap = useCallback((hunkIndex: number) => {
    const { diff, rows, loadDiffFiles } = latest.current;
    const instance = instanceRef.current;
    const gap = findGap(rows, hunkIndex);
    // Without a loader Pierre cannot fetch the file to reveal lines from.
    if (!instance || !gap || (diff.fileDiff.isPartial && !loadDiffFiles)) {
      return;
    }
    instance.expandHunk(hunkIndex, "both", gap.count);
  }, []);

  const reveal = useReveal({ handleRef, itemId, filename, rows, expandGap });

  // -- Selection and mouse ---------------------------------------------------
  const focusedLine = usePRReviewSelector((s) => s.focusedLine);
  const focusedLineSide = usePRReviewSelector((s) => s.focusedLineSide);
  const focusSource = usePRReviewSelector((s) => s.focusSource);
  const selectionAnchor = usePRReviewSelector((s) => s.selectionAnchor);
  const selectionAnchorSide = usePRReviewSelector((s) => s.selectionAnchorSide);

  const selectedLines = useMemo<CodeViewLineSelection | null>(() => {
    const range = focusToRange({
      focusedLine,
      focusedLineSide,
      selectionAnchor,
      selectionAnchorSide,
    });
    return range ? { id: itemId, range } : null;
  }, [
    itemId,
    focusedLine,
    focusedLineSide,
    selectionAnchor,
    selectionAnchorSide,
  ]);

  // Pierre reports every step of a pointer selection (down, drag, up); the
  // store follows along so the rest of the UI sees the live range.
  const onSelectedLinesChange = useCallback(
    (selection: CodeViewLineSelection | null) => {
      const focus = rangeToFocus(
        selection?.id === latest.current.itemId ? selection.range : null
      );
      if (!focus) return;
      const state = store.getSnapshot();
      if (
        state.focusedLine === focus.focusedLine &&
        state.focusedLineSide === focus.focusedLineSide &&
        state.selectionAnchor === focus.selectionAnchor
      ) {
        return;
      }
      store.setFocusedLine(focus.focusedLine, focus.focusedLineSide, "mouse");
      store.setSelectionAnchor(focus.selectionAnchor, focus.focusedLineSide);
    },
    [store]
  );

  // The pointer is released: a selection (clicking a line number, dragging
  // over several, or the gutter "+") opens the comment composer on it.
  const onLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      if (range) {
        const target = rangeToCommentTarget(range);
        if (target)
          store.startCommenting(target.line, target.startLine, target.side);
        return;
      }
      // Clicking the line that is already selected toggles Pierre's
      // selection off; the line stays focused, and the click comments on it.
      const { focusedLine, focusedLineSide } = store.getSnapshot();
      if (focusedLine !== null && focusedLineSide) {
        store.startCommenting(focusedLine, undefined, focusedLineSide);
      }
    },
    [store]
  );

  // Clicking code focuses its line; Shift/Cmd-click extends the selection from
  // the focused line and comments on it. (Line numbers are handled by Pierre's
  // own selection above.)
  const onLineClick = useCallback(
    ({
      lineNumber,
      annotationSide,
      numberColumn,
      event,
    }: {
      lineNumber: number;
      numberColumn: boolean;
      event: MouseEvent;
      /** Only diffs have sides. */
      annotationSide?: AnnotationSide;
    }) => {
      if (numberColumn) return;
      const side = fromPierreSide(annotationSide);
      if (event.shiftKey || event.metaKey) {
        const extend = extendSelection(store.getSnapshot(), lineNumber, side);
        if (extend) {
          window.getSelection()?.removeAllRanges();
          if (extend.anchor) {
            store.setSelectionAnchor(extend.anchor.line, extend.anchor.side);
          }
          store.setFocusedLine(extend.focus.line, extend.focus.side, "mouse");
          store.startCommenting(
            extend.comment.line,
            extend.comment.startLine,
            extend.comment.side
          );
          return;
        }
      }
      // Leave a text selection alone.
      if (window.getSelection()?.toString()) return;
      store.setFocusedLine(lineNumber, side, "mouse");
      store.setSelectionAnchor(null, null);
    },
    [store]
  );

  // -- Scrolling -------------------------------------------------------------
  // Keyboard, goto-line and link navigation scroll the focused line to the
  // middle; mouse focus is already under the pointer.
  useEffect(() => {
    if (focusedLine === null || focusSource === "mouse") return;
    reveal({
      filename,
      side: focusedLineSide ?? "new",
      line: focusedLine,
      align: "center",
    });
  }, [focusedLine, focusedLineSide, focusSource, filename, reveal]);

  useEffect(() => {
    if (focusedGapIndex === null) return;
    const gap = findGap(latest.current.rows, focusedGapIndex);
    const target = gap ? lineNextToGap(latest.current.rows, gap) : null;
    if (!target) return;
    reveal({
      filename,
      side: target.side === "deletions" ? "old" : "new",
      line: target.lineNumber,
      align: "center",
    });
  }, [focusedGapIndex, filename, reveal]);

  useEffect(() => {
    const onTop = () =>
      handleRef.current?.scrollTo({ type: "position", position: 0 });
    // Pierre clamps to the end of the content.
    const onBottom = () =>
      handleRef.current?.scrollTo({
        type: "position",
        position: Number.MAX_SAFE_INTEGER,
      });
    const onExpand = (event: Event) => {
      expandGap((event as CustomEvent<{ hunkIndex: number }>).detail.hunkIndex);
    };
    window.addEventListener("pr-review:scroll-to-top", onTop);
    window.addEventListener("pr-review:scroll-to-bottom", onBottom);
    window.addEventListener("pr-review:expand-skip-block", onExpand);
    return () => {
      window.removeEventListener("pr-review:scroll-to-top", onTop);
      window.removeEventListener("pr-review:scroll-to-bottom", onBottom);
      window.removeEventListener("pr-review:expand-skip-block", onExpand);
    };
  }, [expandGap]);

  // Scroll to a conversation's thread (from the conversations sidebar or a
  // link), then flash it.
  const conversationScrollTarget = usePRReviewSelector(
    (s) => s.conversationScrollTarget
  );
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  useEffect(() => {
    if (!conversationScrollTarget) return;
    // The comments are the selected file's; wait for its diff to show.
    if (selectedFile !== filename) return;
    const thread = layout.threads.find(
      (t) => t.comments[0]?.id === conversationScrollTarget
    );
    const fileThread = layout.fileThreads.find(
      (t) => t.comments[0]?.id === conversationScrollTarget
    );
    // Not placed yet (the diff may still be loading); runs again when it is.
    if (!thread && !fileThread) return;

    let timer: ReturnType<typeof setInterval> | undefined;
    const flash = () => {
      // The thread mounts once Pierre has rendered its line; wait for it.
      let tries = 0;
      timer = setInterval(() => {
        const element = document.getElementById(
          `reviewthread-comment-${conversationScrollTarget}`
        );
        if (!element && ++tries < 20) return;
        clearInterval(timer);
        store.clearConversationScrollTarget();
        if (!element) return;
        element.classList.add("ring-2", "ring-blue-500/50");
        setTimeout(
          () => element.classList.remove("ring-2", "ring-blue-500/50"),
          2000
        );
      }, 100);
    };
    if (thread) {
      reveal({
        filename,
        side: thread.side,
        line: thread.line,
        align: "start",
        onRevealed: flash,
      });
    } else {
      handleRef.current?.scrollTo({ type: "position", position: 0 });
      flash();
    }
    // The line may never become reachable (another request replaced this
    // one, or it is not in the diff): do not keep scrolling to it forever.
    const giveUp = setTimeout(
      () => store.clearConversationScrollTarget(),
      5000
    );
    return () => {
      clearInterval(timer);
      clearTimeout(giveUp);
    };
  }, [conversationScrollTarget, selectedFile, layout, filename, reveal, store]);

  // -- Search ----------------------------------------------------------------
  const searchOverlay = useDiffSearch({
    diff,
    filename,
    rows,
    reveal,
    highlighter,
  });

  // -- Pierre options --------------------------------------------------------
  const options = useMemo<ViewerOptions>(
    () => ({
      theme: DIFF_THEMES,
      themeType,
      lineDiffType: "word-alt",
      diffStyle: viewMode,
      overflow: wordWrap ? "wrap" : "scroll",
      hunkSeparators: "line-info",
      collapsedContextThreshold: DIFF_COLLAPSED_CONTEXT_THRESHOLD,
      loadDiffFiles,
      disableFileHeader: true,
      layout: LAYOUT,
      unsafeCSS: STATIC_CSS,
      lineHoverHighlight: "number",
      enableLineSelection: true,
      enableGutterUtility: true,
      // Pierre only starts a gutter "+" gesture when this is set; the
      // selection it ends with opens the composer (onLineSelectionEnd).
      onGutterUtilityClick: ignoreGutterUtilityClick,
      onLineSelectionEnd,
      onLineClick,
      onPostRender,
    }),
    [
      themeType,
      viewMode,
      wordWrap,
      loadDiffFiles,
      onLineSelectionEnd,
      onLineClick,
      onPostRender,
    ]
  );

  const renderAnnotation = useCallback(
    (...[annotation]: CodeViewAnnotationArgs<AnnotationMeta>) =>
      annotation.metadata ? (
        <div className="font-mono text-[0.8rem]">
          <AnnotationContent
            key={annotation.metadata.key}
            meta={annotation.metadata}
          />
        </div>
      ) : null,
    []
  );

  return (
    <div className="relative flex flex-col flex-1 min-h-0">
      {searchOverlay}
      <CommentLayoutContext.Provider value={layout}>
        <DiffRowsContext.Provider value={rows}>
          <CodeView<AnnotationMeta>
            ref={handleRef}
            items={items}
            options={options}
            className="flex-1 min-h-0 px-4 themed-scrollbar overflow-y-auto overflow-x-hidden"
            style={SCROLLER_STYLE}
            selectedLines={selectedLines}
            onSelectedLinesChange={onSelectedLinesChange}
            renderAnnotation={renderAnnotation}
          />
        </DiffRowsContext.Provider>
      </CommentLayoutContext.Provider>
    </div>
  );
});
