export function measureCommentHeight(
  element: Element,
  entry: ResizeObserverEntry | undefined,
  heights: Map<string | number | bigint, number>,
  key: string | number | bigint,
  hidden: boolean
): number {
  if (hidden) return 0;
  // Virtualizer's default sync measurement can return a cached estimate.
  // Comments must measure their content so following rows cannot cover controls.
  const height = Math.round(
    entry?.borderBoxSize?.[0]?.blockSize ??
      element.getBoundingClientRect().height
  );
  heights.set(key, height);
  return height;
}
