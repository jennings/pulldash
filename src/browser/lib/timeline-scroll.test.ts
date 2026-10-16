import { expect, test } from "bun:test";
import { scrollToTimelineTarget } from "./timeline-scroll";

test("timeline navigation scrolls to mounted targets immediately and waits for late targets without a timer", () => {
  const original = globalThis.MutationObserver;
  const observers: FakeObserver[] = [];
  class FakeObserver {
    active = false;
    constructor(readonly callback: () => void) {
      observers.push(this);
    }
    observe() {
      this.active = true;
    }
    disconnect() {
      this.active = false;
    }
  }
  globalThis.MutationObserver = FakeObserver as never;
  const elements = new Map<string, HTMLElement>();
  const scrolled: string[] = [];
  const root = {
    ownerDocument: { getElementById: (id: string) => elements.get(id) ?? null },
    contains: (element: HTMLElement) =>
      [...elements.values()].includes(element),
  } as unknown as HTMLElement;
  const mount = (id: string) =>
    elements.set(id, {
      scrollIntoView: () => scrolled.push(id),
    } as unknown as HTMLElement);
  let acknowledged = 0;
  try {
    mount("present");
    scrollToTimelineTarget(root, "present", () => acknowledged++);
    expect(scrolled).toEqual(["present"]);
    expect(observers).toHaveLength(0);

    const stop = scrollToTimelineTarget(root, "late", () => acknowledged++);
    expect(observers[0]?.active).toBe(true);
    observers[0]!.callback();
    expect(acknowledged).toBe(1);
    mount("late");
    observers[0]!.callback();
    observers[0]!.callback();
    expect(scrolled).toEqual(["present", "late"]);
    expect(acknowledged).toBe(2);
    expect(observers[0]?.active).toBe(false);
    stop();

    const cancel = scrollToTimelineTarget(
      root,
      "cancelled",
      () => acknowledged++
    );
    cancel();
    mount("cancelled");
    observers[1]!.callback();
    expect(scrolled).toEqual(["present", "late"]);
  } finally {
    globalThis.MutationObserver = original;
  }
});
