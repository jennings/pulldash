import { Loader2, Search, ChevronsUpDown } from "lucide-react";
import { useState, useCallback, useEffect, useMemo, useRef, memo } from "react";
import { Command } from "cmdk";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { MarkdownEditor } from "../ui/markdown";
import { usePRReviewStore, usePRReviewSelector } from "../contexts/pr-review";
import { cn } from "../cn";

interface PREditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const PREditDialog = memo(function PREditDialog({
  open,
  onOpenChange,
}: PREditDialogProps) {
  const store = usePRReviewStore();
  const pr = usePRReviewSelector((s) => s.pr);
  const updatingPR = usePRReviewSelector((s) => s.updatingPR);

  const [title, setTitle] = useState(pr.title);
  const [body, setBody] = useState(pr.body ?? "");
  const [base, setBase] = useState(pr.base.ref);
  const [branches, setBranches] = useState<Array<{ name: string }>>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchSearch, setBranchSearch] = useState("");
  const branchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!branchOpen) return;
    const handler = (e: MouseEvent) => {
      if (branchRef.current && !branchRef.current.contains(e.target as Node)) {
        setBranchOpen(false);
        setBranchSearch("");
      }
    };
    document.addEventListener("mousedown", handler, { capture: true });
    return () =>
      document.removeEventListener("mousedown", handler, { capture: true });
  }, [branchOpen]);

  const filteredBranches = useMemo(() => {
    const q = branchSearch.toLowerCase().trim();
    if (!q) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, branchSearch]);

  useEffect(() => {
    if (open && branches.length === 0 && !branchesLoading) {
      setBranchesLoading(true);
      store
        .getRepoBranches()
        .then((data) => {
          setBranches(data);
          setBranchesLoading(false);
        })
        .catch(() => setBranchesLoading(false));
    }
  }, [open, store, branches.length, branchesLoading]);

  useEffect(() => {
    if (open) {
      setTitle(pr.title);
      setBody(pr.body ?? "");
      setBase(pr.base.ref);
    }
  }, [open, pr.title, pr.body, pr.base.ref]);

  const handleSave = useCallback(async () => {
    const params: { title?: string; body?: string; base?: string } = {};
    if (title !== pr.title) params.title = title;
    if (body !== (pr.body ?? "")) params.body = body;
    if (base !== pr.base.ref) params.base = base;

    if (Object.keys(params).length === 0) {
      onOpenChange(false);
      return;
    }

    const success = await store.updatePR(params);
    if (success) {
      onOpenChange(false);
    }
  }, [store, title, body, base, pr, onOpenChange]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!updatingPR) {
        onOpenChange(open);
      }
    },
    [updatingPR, onOpenChange]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={!updatingPR} className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit pull request</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <label className="text-sm font-medium">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full h-9 px-3 rounded-md border bg-background text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              disabled={updatingPR}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Description</label>
            <MarkdownEditor
              value={body}
              onChange={setBody}
              minHeight="80px"
              maxHeight="40vh"
              disabled={updatingPR}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Base branch</label>
            {branchesLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground h-9">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading branches...
              </div>
            ) : (
              <div className="relative" ref={branchRef}>
                <button
                  role="combobox"
                  aria-expanded={branchOpen}
                  disabled={updatingPR}
                  onClick={() => setBranchOpen(!branchOpen)}
                  className="w-full h-9 px-3 rounded-md border bg-background text-foreground text-sm flex items-center justify-between focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50"
                >
                  <span className="truncate">{base}</span>
                  <ChevronsUpDown className="w-4 h-4 text-muted-foreground shrink-0" />
                </button>
                {branchOpen && (
                  <div className="absolute z-50 top-full mt-1 left-0 right-0 rounded-lg border border-border bg-card shadow-xl">
                    <Command shouldFilter={false}>
                      <div className="flex items-center border-b px-3 gap-2">
                        <Search className="w-4 h-4 text-muted-foreground shrink-0" />
                        <input
                          value={branchSearch}
                          onChange={(e) => setBranchSearch(e.target.value)}
                          placeholder="Search branches..."
                          className="flex-1 h-9 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                          autoFocus
                        />
                      </div>
                      <div className="max-h-60 overflow-y-auto p-1">
                        {filteredBranches.length === 0 ? (
                          <div className="py-6 text-center text-sm text-muted-foreground">
                            No branches found.
                          </div>
                        ) : (
                          filteredBranches.map((b) => (
                            <div
                              key={b.name}
                              role="option"
                              aria-selected={b.name === base}
                              onClick={() => {
                                setBase(b.name);
                                setBranchOpen(false);
                                setBranchSearch("");
                              }}
                              className={cn(
                                "px-3 py-2 text-sm rounded-md cursor-pointer flex items-center gap-2",
                                b.name === base
                                  ? "bg-accent text-accent-foreground"
                                  : "hover:bg-accent hover:text-accent-foreground"
                              )}
                            >
                              <span className="truncate">{b.name}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </Command>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={updatingPR}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={updatingPR}>
            {updatingPR && <Loader2 className="w-4 h-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
