import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import {
  mergeSearchMatches,
  searchPatches,
  searchRows,
  type PatchMatch,
} from "../../lib/diff-search";
import type { DiffRow, LoadedDiff } from "../../lib/file-diff";
import {
  usePRReviewSelector,
  usePRReviewStore,
} from "../../contexts/pr-review";
import { isSameMatch, type SearchHighlighter } from "./search-highlight";
import type { RevealTarget } from "./use-reveal";

interface UseDiffSearchArgs {
  diff: LoadedDiff;
  /** File the displayed `diff` belongs to. */
  filename: string;
  rows: readonly DiffRow[];
  reveal: (target: RevealTarget) => void;
  highlighter: SearchHighlighter;
}

/**
 * Cmd/Ctrl+F search over the diff: matches in the open file come from its
 * rows (expansion aware), matches in the other files from their raw patches,
 * so Enter walks across files. Pierre owns the rendered lines, so painting
 * goes through `highlighter` and scrolling through `reveal`.
 */
export function useDiffSearch({
  diff,
  filename,
  rows,
  reveal,
  highlighter,
}: UseDiffSearchArgs) {
  const store = usePRReviewStore();
  const files = usePRReviewSelector((s) => s.files);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // A match in another file, to reveal once that file's diff is showing.
  const pendingMatchRef = useRef<PatchMatch | null>(null);
  const autoScrolledQueryRef = useRef<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  // Cmd/Ctrl+F opens search outside text fields; Esc closes it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (e.key === "Escape" && open) {
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  const searching = open && debouncedQuery !== "";
  const rowMatches = useMemo(
    () =>
      searching
        ? searchRows(rows, debouncedQuery, { fileDiff: diff.fileDiff })
        : [],
    [rows, debouncedQuery, searching, diff.fileDiff]
  );
  const patchMatches = useMemo(
    () =>
      searching
        ? searchPatches(files, debouncedQuery, { excludeFilename: filename })
        : [],
    [files, debouncedQuery, searching, filename]
  );
  const searchMatches = useMemo(
    () => mergeSearchMatches(files, filename, rowMatches, patchMatches),
    [files, filename, rowMatches, patchMatches]
  );
  const activeIndex = searchMatches.length
    ? Math.min(activeMatchIndex, searchMatches.length - 1)
    : 0;
  const activeMatch = searchMatches[activeIndex];

  useEffect(() => {
    highlighter.setMatches(
      rowMatches,
      activeMatch?.filename === filename ? activeMatch : null
    );
  }, [highlighter, rowMatches, activeMatch, filename]);

  const revealMatch = useCallback(
    (match: PatchMatch) =>
      reveal({
        filename: match.filename,
        side: match.side,
        line: match.lineNumber,
        align: "center",
      }),
    [reveal]
  );

  const goToMatch = useCallback(
    (index: number) => {
      if (searchMatches.length === 0) return;
      const i =
        ((index % searchMatches.length) + searchMatches.length) %
        searchMatches.length;
      setActiveMatchIndex(i);
      const match = searchMatches[i];
      if (match.filename === filename) {
        pendingMatchRef.current = null;
        revealMatch(match);
        return;
      }
      pendingMatchRef.current = match;
      store.selectFile(match.filename);
    },
    [searchMatches, filename, revealMatch, store]
  );

  // Reveal a match in another file once its diff is showing, and point the
  // counter at it (its index moved when the diff's own matches replaced the
  // patch-derived ones).
  useEffect(() => {
    const target = pendingMatchRef.current;
    if (!target || target.filename !== filename) return;
    pendingMatchRef.current = null;
    revealMatch(target);
    const index = searchMatches.findIndex(
      (m) => m.filename === filename && isSameMatch(target, m)
    );
    if (index !== -1) setActiveMatchIndex(index);
  }, [filename, searchMatches, revealMatch]);

  // Browser-like: when the query changes, go to the first match in the open
  // file (never yanking the user to another file while typing) or, failing
  // that, the first match in the next file that has one.
  useEffect(() => {
    if (!searching) return;
    if (autoScrolledQueryRef.current === debouncedQuery) return;
    autoScrolledQueryRef.current = debouncedQuery;
    // Matches hidden in a collapsed gap come last: typing should not expand
    // a gap just to land on a match in it.
    const inFile = (m: PatchMatch) => m.filename === filename;
    const firstInFile = searchMatches.some((m) => inFile(m) && !m.inGap)
      ? searchMatches.findIndex((m) => inFile(m) && !m.inGap)
      : searchMatches.findIndex(inFile);
    if (firstInFile !== -1) {
      setActiveMatchIndex(firstInFile);
      revealMatch(searchMatches[firstInFile]);
      return;
    }
    if (searchMatches.length === 0) {
      setActiveMatchIndex(0);
      return;
    }
    const filePos = new Map(files.map((f, i) => [f.filename, i]));
    const currentPos = filePos.get(filename) ?? -1;
    const target = searchMatches.findIndex(
      (m) => (filePos.get(m.filename) ?? -1) >= currentPos
    );
    goToMatch(target === -1 ? 0 : target);
  }, [
    searching,
    debouncedQuery,
    searchMatches,
    files,
    filename,
    goToMatch,
    revealMatch,
  ]);

  // A new search starts afresh after closing.
  useEffect(() => {
    if (!open) autoScrolledQueryRef.current = null;
  }, [open]);

  const overlay = open ? (
    <div className="absolute top-2 right-6 z-30 flex items-center gap-1.5 bg-card border border-border rounded-md shadow-lg px-2 py-1.5">
      <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <input
        ref={inputRef}
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            goToMatch(activeIndex + (e.shiftKey ? -1 : 1));
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
        placeholder="Search in diff..."
        className="w-44 h-6 px-2 text-xs bg-muted border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
        {debouncedQuery
          ? `${searchMatches.length > 0 ? activeIndex + 1 : 0}/${searchMatches.length}`
          : ""}
      </span>
      <button
        onClick={() => goToMatch(activeIndex - 1)}
        disabled={searchMatches.length === 0}
        className="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors disabled:opacity-40"
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={() => goToMatch(activeIndex + 1)}
        disabled={searchMatches.length === 0}
        className="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors disabled:opacity-40"
        title="Next match (Enter)"
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      <button
        onClick={close}
        className="p-1 text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
        title="Close (Esc)"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  ) : null;

  return overlay;
}
