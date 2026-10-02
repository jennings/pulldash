/**
 * A random v4-shaped id.
 *
 * `crypto.randomUUID` is secure-context-only, so it is `undefined` on a
 * plain-HTTP origin. That matters more than it looks: a fresh profile has no
 * persisted state, so ids get generated during the very first render — the
 * insecure origin and the first run are the same situation, and a throw there
 * takes down the whole app.
 *
 * `crypto.getRandomValues` is available in every context, so fall back to
 * building the same shape from it. The output is not a real v4 by spec
 * (randomUUID's version nibble is not guaranteed either), only shaped like one,
 * which is all these ids need: local uniqueness.
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
