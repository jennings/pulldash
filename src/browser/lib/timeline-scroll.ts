export function scrollToTimelineTarget(
  root: HTMLElement,
  id: string,
  onFound: () => void
): () => void {
  let stopped = false;
  const reveal = () => {
    if (stopped) return false;
    const element = root.ownerDocument.getElementById(id);
    if (!element || !root.contains(element)) return false;
    stopped = true;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    onFound();
    return true;
  };
  if (reveal()) return () => {};
  const observer = new MutationObserver(() => {
    if (reveal()) observer.disconnect();
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => {
    stopped = true;
    observer.disconnect();
  };
}
