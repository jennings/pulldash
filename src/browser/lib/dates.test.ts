import { test, expect } from "bun:test";
import {
  formatDate,
  formatDateTime,
  formatDateTimeSeconds,
  getTimeAgo,
} from "./dates";

test("formatDateTimeSeconds adds seconds to formatDateTime", () => {
  const date = new Date(2026, 8, 29, 14, 5, 9);
  expect(formatDateTimeSeconds(date)).toBe(`${formatDateTime(date)}:09`);
  expect(formatDate(date)).toBe("29 Sept 2026");
});

test("getTimeAgo coarsens to minutes, hours and days", () => {
  const now = Date.now();
  expect(getTimeAgo(new Date(now - 30_000))).toBe("just now");
  expect(getTimeAgo(new Date(now - 5 * 60_000))).toBe("5m ago");
  expect(getTimeAgo(new Date(now - 3 * 3_600_000))).toBe("3h ago");
  expect(getTimeAgo(new Date(now - 2 * 86_400_000))).toBe("2d ago");
});
