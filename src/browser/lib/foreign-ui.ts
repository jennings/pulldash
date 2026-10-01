/** The element `createRoot` mounts into — see src/browser/index.tsx. Events
 *  from our own UI always pass through it; injected extension UI does not. */
const APP_ROOT_ID = "app";

function isInShadowTree(node: unknown): boolean {
  const target = node as
    | { getRootNode?: () => unknown; ownerDocument?: unknown }
    | undefined;
  return (
    typeof target?.getRootNode === "function" &&
    target.getRootNode() !== target?.ownerDocument
  );
}

/**
 * Whether a composed event path belongs to UI this app does not own, such as a
 * browser extension's injected panel. Extensions attach a shadow root to an
 * element beside the app so their styles cannot collide with ours, and click
 * the suggestion popups they render there.
 *
 * Dismissable layers decide "outside" purely by whether an event passed through
 * the React tree, and are not shadow-aware, so such a click reads as an outside
 * click. Grammarly's suggestion popup is the case that matters: it closes the
 * submit-review dropdown, twice over, once for the pointerdown and again for
 * the focus that lands on the suggestion.
 *
 * Shadow detection comes first because it is the mechanism and needs no
 * knowledge of where an extension injects itself. Only `composedPath()[0]` can
 * see it: `event.target` is retargeted to the shadow host by the time a
 * document-level listener sees it, but the path is not.
 *
 * Free of DOM globals so it can be tested directly.
 */
export function isForeignPath(
  path: readonly unknown[],
  appRoot: unknown
): boolean {
  // No path means no information; do not read that as foreign.
  if (path.length === 0) return false;
  if (isInShadowTree(path[0])) return true;
  if (appRoot) return !path.includes(appRoot);
  return false;
}

export function isForeignUiEvent(event: Event): boolean {
  return isForeignPath(
    event.composedPath(),
    document.getElementById(APP_ROOT_ID)
  );
}
