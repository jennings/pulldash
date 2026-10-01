import { test, expect } from "bun:test";
import { isForeignPath } from "./foreign-ui";

const APP_ROOT = { id: "app" };
const DOCUMENT = { ownerDocument: null };

/** A node inside a shadow tree: its root node is not its document. */
function shadowed(): unknown {
  const self = { ownerDocument: DOCUMENT } as Record<string, unknown>;
  return { ...self, getRootNode: () => ({ id: "shadow-root" }) };
}

test("events that passed through our own DOM are not foreign", () => {
  const content = { id: "content" };
  expect(isForeignPath([content, APP_ROOT, DOCUMENT], APP_ROOT)).toBe(false);
});

test("a click inside an extension's shadow tree is foreign", () => {
  // composedPath()[0] is the node the event actually landed on, inside the
  // shadow root; the shadow host beside it is what retargeting would expose.
  const host = { id: "grammarly-host", ownerDocument: DOCUMENT };
  expect(isForeignPath([shadowed(), host, DOCUMENT, APP_ROOT], APP_ROOT)).toBe(
    true
  );
});

test("extension UI injected into the body is foreign too", () => {
  const injected = { id: "injected", ownerDocument: DOCUMENT };
  expect(isForeignPath([injected, DOCUMENT], APP_ROOT)).toBe(true);
});

test("focus landing in a shadow tree is foreign even inside the app", () => {
  // An extension that injects a host into the app still gets caught, because
  // shadow detection does not care where the host lives.
  const self = { ownerDocument: DOCUMENT } as Record<string, unknown>;
  const app = { ...self, id: "app", getRootNode: () => DOCUMENT };
  expect(isForeignPath([shadowed(), app, DOCUMENT], app)).toBe(true);
});

test("falls back to shadow detection with no app root", () => {
  expect(isForeignPath([shadowed(), DOCUMENT], null)).toBe(true);
  expect(
    isForeignPath(
      [{ ownerDocument: DOCUMENT, getRootNode: () => DOCUMENT }],
      null
    )
  ).toBe(false);
});

test("an empty path is not foreign", () => {
  expect(isForeignPath([], APP_ROOT)).toBe(false);
  expect(isForeignPath([], null)).toBe(false);
});
