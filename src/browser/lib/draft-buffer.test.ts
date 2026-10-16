import { expect, test } from "bun:test";
import { DraftBuffer } from "./draft-buffer";

test("drafts stay local until a checkpoint and flush only the latest value", () => {
  let pending: (() => void) | undefined;
  const writes: string[] = [];
  const draft = new DraftBuffer(
    "saved",
    (value) => writes.push(value),
    (callback) => {
      pending = callback;
      return () => {
        pending = undefined;
      };
    }
  );
  draft.update("one");
  draft.update("latest");
  expect(writes).toEqual([]);
  expect(draft.value).toBe("latest");
  pending!();
  expect(writes).toEqual(["latest"]);
  draft.flush();
  expect(writes).toHaveLength(1);
  draft.update("before navigation");
  draft.flush();
  expect(writes).toEqual(["latest", "before navigation"]);
  expect(pending).toBeUndefined();
});

test("clearing or replacing a draft cancels pending persistence", () => {
  let pending: (() => void) | undefined;
  const writes: string[] = [];
  const draft = new DraftBuffer(
    "",
    (value) => writes.push(value),
    (callback) => {
      pending = callback;
      return () => {
        pending = undefined;
      };
    }
  );
  draft.update("submitted");
  draft.reset("");
  draft.flush();
  expect(writes).toEqual([]);
  expect(pending).toBeUndefined();
  draft.update("keep on close");
  draft.flush();
  draft.update("");
  draft.flush();
  expect(writes).toEqual(["keep on close", ""]);
});
