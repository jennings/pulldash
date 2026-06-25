// Top-of-page progress indicator for in-flight commit data fetches.
// Wraps the nanobar library with refcounting so multiple overlapping
// fetches stay represented as a single bar.

import Nanobar from "nanobar";

type NanobarInstance = InstanceType<typeof Nanobar>;

const SHOW_DELAY_MS = 80;
const TICK_MS = 200;

let bar: NanobarInstance | null = null;
let pending = 0;
let progress = 0;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;

function ensureBar(): NanobarInstance {
  if (!bar) {
    bar = new Nanobar({ classname: "nanobar-pulldash" });
  }
  return bar;
}

function startTicking() {
  if (tickTimer) return;
  progress = 8;
  ensureBar().go(progress);
  tickTimer = setInterval(() => {
    if (progress < 90 && bar) {
      progress = progress + Math.max(1, (90 - progress) * 0.1);
      bar.go(progress);
    }
  }, TICK_MS);
}

function stopTicking() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (bar) {
    bar.go(100);
  }
  progress = 0;
}

export function beginFetch(): void {
  pending++;
  if (pending === 1) {
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      showTimer = null;
      if (pending > 0) startTicking();
    }, SHOW_DELAY_MS);
  }
}

export function endFetch(): void {
  pending = Math.max(0, pending - 1);
  if (pending === 0) {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    if (tickTimer) stopTicking();
  }
}

export async function trackFetch<T>(fn: () => Promise<T>): Promise<T> {
  beginFetch();
  try {
    return await fn();
  } finally {
    endFetch();
  }
}
