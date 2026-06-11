import { test, expect, beforeEach } from "bun:test";
import "fake-indexeddb/auto";
import { get, put, deleteByPRKey, clear } from "./persistent-cache";

beforeEach(async () => {
  await clear();
});

test("put then get returns the stored value", async () => {
  await put("key1", { data: 42 }, "owner/repo/1");
  const result = await get<{ data: number }>("key1");
  expect(result).toEqual({ data: 42 });
});

test("get on missing key returns null", async () => {
  const result = await get("nonexistent");
  expect(result).toBeNull();
});

test("deleteByPRKey removes only matching entries", async () => {
  await put("key-a", "value-a", "owner/repo/1");
  await put("key-b", "value-b", "owner/repo/1");
  await put("key-c", "value-c", "owner/repo/2");

  await deleteByPRKey("owner/repo/1");

  expect(await get("key-a")).toBeNull();
  expect(await get("key-b")).toBeNull();
  expect(await get<string>("key-c")).toBe("value-c");
});

test("clear empties the store", async () => {
  await put("key1", "value1", "owner/repo/1");
  await put("key2", "value2", "owner/repo/2");

  await clear();

  expect(await get("key1")).toBeNull();
  expect(await get("key2")).toBeNull();
});
