// Paints diff search matches inside Pierre's shadow DOM with the CSS Custom
// Highlight API: Pierre owns the line DOM (and re-creates it while scrolling),
// so matches are a set of Ranges recomputed from the rendered lines rather
// than markup. The `::highlight()` rules live in the shadow root's `unsafeCSS`
// (see decorations.ts).

import type { DiffSearchMatch } from "../../lib/diff-search";
import { SEARCH_HIGHLIGHT, SEARCH_HIGHLIGHT_ACTIVE } from "./decorations";
import { forEachRenderedLine, locateTextRange } from "./rendered-lines";
import type { LineSide } from "./selection";

export type HighlightMatch = Pick<
  DiffSearchMatch,
  "side" | "lineNumber" | "start" | "end"
>;

export const lineKey = (side: LineSide, line: number) => `${side}:${line}`;

/** Matches grouped by the line they are on. */
export function groupMatchesByLine(
  matches: readonly HighlightMatch[]
): Map<string, HighlightMatch[]> {
  const byLine = new Map<string, HighlightMatch[]>();
  for (const match of matches) {
    const key = lineKey(match.side, match.lineNumber);
    const list = byLine.get(key);
    if (list) list.push(match);
    else byLine.set(key, [match]);
  }
  return byLine;
}

export function isSameMatch(
  a: HighlightMatch | null | undefined,
  b: HighlightMatch
): boolean {
  return (
    !!a &&
    a.side === b.side &&
    a.lineNumber === b.lineNumber &&
    a.start === b.start &&
    a.end === b.end
  );
}

export function supportsSearchHighlight(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  );
}

function textNodesOf(line: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
}

function rangesForLine(
  line: HTMLElement,
  matches: readonly HighlightMatch[]
): Range[] {
  const nodes = textNodesOf(line);
  const lengths = nodes.map((node) => node.data.length);
  const ranges: Range[] = [];
  for (const match of matches) {
    const bounds = locateTextRange(lengths, match.start, match.end);
    if (!bounds) continue;
    const range = new Range();
    range.setStart(nodes[bounds.startNode], bounds.startOffset);
    range.setEnd(nodes[bounds.endNode], bounds.endOffset);
    ranges.push(range);
  }
  return ranges;
}

/**
 * Keeps `CSS.highlights` in sync with the search state and the lines Pierre
 * currently has rendered. Register each rendered diff container with
 * `attach`; call `refresh` after Pierre re-renders it.
 */
export class SearchHighlighter {
  private containers = new Set<HTMLElement>();
  private byLine = new Map<string, HighlightMatch[]>();
  private active: HighlightMatch | null = null;
  /** Highlights are registered, so clearing them is not a no-op. */
  private painted = false;

  setMatches(
    matches: readonly HighlightMatch[],
    active: HighlightMatch | null
  ): void {
    this.byLine = groupMatchesByLine(matches);
    this.active = active;
    this.paint();
  }

  attach(container: HTMLElement): void {
    this.containers.add(container);
    this.paint();
  }

  detach(container: HTMLElement): void {
    this.containers.delete(container);
    this.paint();
  }

  /** Re-collect ranges after the rendered lines changed. */
  refresh(): void {
    this.paint();
  }

  dispose(): void {
    this.containers.clear();
    this.clearHighlights();
  }

  private clearHighlights(): void {
    if (!this.painted || !supportsSearchHighlight()) return;
    this.painted = false;
    CSS.highlights.delete(SEARCH_HIGHLIGHT);
    CSS.highlights.delete(SEARCH_HIGHLIGHT_ACTIVE);
  }

  private paint(): void {
    if (!supportsSearchHighlight()) return;
    if (this.byLine.size === 0 || this.containers.size === 0) {
      this.clearHighlights();
      return;
    }
    const others: Range[] = [];
    const current: Range[] = [];
    for (const container of this.containers) {
      const root = container.shadowRoot;
      if (!root) continue;
      forEachRenderedLine(root, "[data-line]", (element, side, line) => {
        const matches = this.byLine.get(lineKey(side, line));
        if (!matches) return;
        const regular = matches.filter((m) => !isSameMatch(this.active, m));
        others.push(...rangesForLine(element, regular));
        if (regular.length !== matches.length) {
          current.push(
            ...rangesForLine(
              element,
              matches.filter((m) => isSameMatch(this.active, m))
            )
          );
        }
      });
    }
    this.painted = true;
    CSS.highlights.set(SEARCH_HIGHLIGHT, new Highlight(...others));
    const active = new Highlight(...current);
    // Over the other matches where they overlap.
    active.priority = 1;
    CSS.highlights.set(SEARCH_HIGHLIGHT_ACTIVE, active);
  }
}
