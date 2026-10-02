import { test, expect } from "bun:test";
import { randomId } from "./ids";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Emulate an insecure origin, where `crypto.randomUUID` does not exist.
 *
 * It is inherited rather than an own property, so `delete` silently does
 * nothing and the test would pass while exercising the fast path. Shadowing it
 * with `defineProperty` is what actually removes it.
 *
 * `onFallback` lets a caller assert the fallback really ran.
 */
function withoutRandomUUID<T>(fn: () => T, onFallback: () => void): T {
  const own = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  const realGetRandomValues = crypto.getRandomValues;
  Object.defineProperty(crypto, "randomUUID", {
    value: undefined,
    configurable: true,
  });
  crypto.getRandomValues = ((
    ...args: Parameters<typeof realGetRandomValues>
  ) => {
    onFallback();
    return realGetRandomValues.apply(crypto, args);
  }) as typeof crypto.getRandomValues;
  try {
    expect(typeof crypto.randomUUID).toBe("undefined");
    return fn();
  } finally {
    crypto.getRandomValues = realGetRandomValues;
    if (own) Object.defineProperty(crypto, "randomUUID", own);
    else delete (crypto as { randomUUID?: unknown }).randomUUID;
    expect(typeof crypto.randomUUID).toBe("function");
  }
}

test("produces a v4-shaped id", () => {
  expect(randomId()).toMatch(UUID_V4);
});

test("falls back to getRandomValues when randomUUID is absent", () => {
  let fellBack = false;
  const id = withoutRandomUUID(
    () => randomId(),
    () => {
      fellBack = true;
    }
  );
  expect(fellBack).toBe(true);
  expect(id).toMatch(UUID_V4);
});

test("the fallback is unique", () => {
  const ids = withoutRandomUUID(
    () => Array.from({ length: 5000 }, randomId),
    () => {}
  );
  expect(new Set(ids).size).toBe(5000);
});

test("uses randomUUID when it is available", () => {
  const own = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  let called = false;
  Object.defineProperty(crypto, "randomUUID", {
    value: () => {
      called = true;
      return "00000000-0000-4000-8000-000000000000";
    },
    configurable: true,
  });
  try {
    expect(randomId()).toBe("00000000-0000-4000-8000-000000000000");
    expect(called).toBe(true);
  } finally {
    if (own) Object.defineProperty(crypto, "randomUUID", own);
    else delete (crypto as { randomUUID?: unknown }).randomUUID;
  }
});
