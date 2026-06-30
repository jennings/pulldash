import { Fragment, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { Keycap, KeycapGroup } from "../ui/keycap";

// A single action: outer list is "or"-joined alternates, each inner list is one combo.
type KeyAlts = string[][];

interface Shortcut {
  description: string;
  // Two entries = paired (e.g., previous / next), rendered with "/" between.
  // One entry = single action, alternates joined with "or".
  keys: [KeyAlts] | [KeyAlts, KeyAlts];
}

interface ShortcutSection {
  title: string;
  shortcuts: Shortcut[];
}

const SECTIONS: ShortcutSection[] = [
  {
    title: "Global",
    shortcuts: [
      { keys: [[["?"]]], description: "Show this shortcuts reference" },
      {
        keys: [
          [
            ["cmd", "k"],
            ["cmd", "p"],
          ],
        ],
        description: "Open command palette (file search)",
      },
      { keys: [[["cmd", "1"]]], description: "Switch to tab 1–9" },
      { keys: [[["cmd", "w"]]], description: "Close current tab" },
    ],
  },
  {
    title: "PR Overview",
    shortcuts: [
      {
        keys: [
          [["k"], ["up"]],
          [["j"], ["down"]],
        ],
        description: "Focus previous / next comment, review, or event",
      },
      { keys: [[["r"]]], description: "Reply to focused comment" },
      { keys: [[["esc"]]], description: "Clear focus / cancel reply" },
    ],
  },
  {
    title: "Diff View",
    shortcuts: [
      {
        keys: [[["k"]], [["j"]]],
        description: "Previous / next unviewed file",
      },
      {
        keys: [[["["]], [["]"]]],
        description: "Previous / next commit",
      },
      { keys: [[["v"]]], description: "Toggle viewed on current file" },
      { keys: [[["o"]]], description: "Go to PR overview" },
      { keys: [[["c"]]], description: "Comment on focused line" },
      { keys: [[["w"]]], description: "Toggle word wrap" },
      { keys: [[["h"]]], description: "Toggle comments visibility" },
      { keys: [[["e"]]], description: "Edit focused comment" },
      { keys: [[["r"]]], description: "Reply to focused comment" },
      { keys: [[["d"]]], description: "Delete focused comment" },
      { keys: [[["s"]]], description: "Open submit-review menu" },
      { keys: [[["alt", "s"]]], description: "Approve without comment" },
      { keys: [[["g"]]], description: "Enter goto-line mode" },
      {
        keys: [[["esc"]]],
        description: "Clear selection / cancel commenting",
      },
    ],
  },
  {
    title: "Diff View — Line Navigation",
    shortcuts: [
      {
        keys: [[["up"]], [["down"]]],
        description: "Move up / down one line",
      },
      {
        keys: [[["left"]], [["right"]]],
        description: "Switch left / right side (split view)",
      },
      {
        keys: [[["cmd", "up"]], [["cmd", "down"]]],
        description: "Jump up / down 10 lines",
      },
      { keys: [[["shift", "down"]]], description: "Extend selection" },
    ],
  },
  {
    title: "Goto Line Mode",
    shortcuts: [
      { keys: [[["0"]]], description: "Type digits to enter line number" },
      { keys: [[["enter"]]], description: "Jump to entered line" },
      { keys: [[["g"]]], description: "Jump to top of file" },
      { keys: [[["e"]]], description: "Jump to bottom of file" },
      { keys: [[["tab"]]], description: "Toggle left / right side" },
      { keys: [[["backspace"]]], description: "Delete last digit" },
      { keys: [[["esc"]]], description: "Cancel goto-line mode" },
    ],
  },
  {
    title: "Submit Review",
    shortcuts: [{ keys: [[["cmd", "enter"]]], description: "Submit review" }],
  },
  {
    title: "Image Preview",
    shortcuts: [
      { keys: [[["+"], ["="]], [["-"]]], description: "Zoom in / out" },
      { keys: [[["0"]]], description: "Reset zoom" },
      { keys: [[["esc"]]], description: "Close preview" },
    ],
  },
];

function ShortcutKeys({ shortcut }: { shortcut: Shortcut }) {
  return (
    <span className="flex items-center gap-1.5 shrink-0">
      {shortcut.keys.map((alts, sideIndex) => (
        <Fragment key={sideIndex}>
          {sideIndex > 0 && <span className="text-muted-foreground/60">/</span>}
          {alts.map((combo, altIndex) => (
            <Fragment key={altIndex}>
              {altIndex > 0 && (
                <span className="text-[10px] text-muted-foreground/60">or</span>
              )}
              <KeycapGroup keys={combo} size="xs" />
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

export function ShortcutsDialog() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "?") return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setOpen((prev) => !prev);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press <Keycap keyName="?" size="xs" /> any time to open this
            reference.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5 text-sm">
          {SECTIONS.map((section) => (
            <section key={section.title} className="break-inside-avoid">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                {section.title}
              </h3>
              <ul className="space-y-1.5">
                {section.shortcuts.map((shortcut, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="text-foreground/90">
                      {shortcut.description}
                    </span>
                    <ShortcutKeys shortcut={shortcut} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
