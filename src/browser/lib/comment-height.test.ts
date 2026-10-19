import { expect, test } from "bun:test";
import { Virtualizer } from "@tanstack/virtual-core";
import { measureCommentHeight } from "./comment-height";

test("following rows stay below a comment when estimates, editing, and visibility change", () => {
  const heights = new Map<string | number | bigint, number>();
  let height = 164;
  let reads = 0;
  const element = {
    getBoundingClientRect: () => {
      reads++;
      return { height };
    },
  } as HTMLElement;
  const key = "file-unified-pending-comment";
  const virtualizer = new Virtualizer({
    count: 2,
    getScrollElement: () => null,
    estimateSize: (index) => (index === 0 ? 100 : 20),
    scrollToFn: () => {},
    observeElementRect: () => {},
    observeElementOffset: () => {},
  });
  const measure = (hidden = false, entry?: ResizeObserverEntry) => {
    virtualizer.getTotalSize();
    virtualizer.resizeItem(
      0,
      measureCommentHeight(element, entry, heights, key, hidden)
    );
    virtualizer.getTotalSize();
    return virtualizer.measurementsCache[1]!.start;
  };

  expect(measure()).toBe(164);
  // Reusing a mounted row after its data changes must not retain a stale estimate.
  virtualizer.resizeItem(0, 100);
  expect(measure()).toBe(164);
  expect(measure(true)).toBe(0);
  expect(heights.get(key)).toBe(164);
  expect(measure()).toBe(164);

  height = 280;
  const previousReads = reads;
  expect(
    measure(false, {
      borderBoxSize: [{ blockSize: 280 }],
    } as unknown as ResizeObserverEntry)
  ).toBe(280);
  expect(reads).toBe(previousReads);
  expect(heights.get(key)).toBe(280);
});
