import { useEffect, useRef, useState } from "react";
import { ApiError, deleteAllocation, listAllocations, type Allocation, type AssetConfig } from "./api";
import { weightsText } from "./format";

const asPct = (w: Record<string, number>) => ({ equity: w.NIFTY ?? 0, gold: w.GOLD ?? 0, bonds: w.BOND ?? 0 });

/** "Open plan" button above the Allocation sliders: lists every plan (Predefined and the ones
 *  you saved) and loads the one you click into the sliders (Cash = the rest). */
export default function OpenPlan({ current, onOpen }: {
  current: { equity: number; gold: number; bonds: number };
  onOpen: (weights: { equity: number; gold: number; bonds: number }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<Record<string, AssetConfig>>({});
  const [plans, setPlans] = useState<Allocation[] | null>(null);
  const [error, setError] = useState(false);
  const [msg, setMsg] = useState("");
  const box = useRef<HTMLDivElement>(null);

  const remove = async (a: Allocation) => {
    if (!window.confirm(`Delete "${a.name}"? This cannot be undone.`)) return;
    try {
      await deleteAllocation(a.id);
      setPlans((cur) => (cur ? cur.filter((x) => x.id !== a.id) : cur));
      setMsg("");
    } catch (e) {
      setMsg(e instanceof ApiError ? e.errors.join(" ") : String(e));
    }
  };

  // read the list each time it is opened, so a plan saved a moment ago is there
  useEffect(() => {
    if (!open) return;
    listAllocations()
      .then((d) => { setAssets(d.assets); setPlans(d.allocations); setError(false); })
      .catch(() => setError(true));
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const groups: [string, Allocation[]][] = [
    ["Saved by you", (plans ?? []).filter((a) => a.type === "custom")],
    ["Predefined", (plans ?? []).filter((a) => a.type === "predefined")],
  ];
  const same = (a: Allocation) => {
    const w = asPct(a.weights);
    return w.equity === current.equity && w.gold === current.gold && w.bonds === current.bonds;
  };

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-panel px-3 py-2 text-sm font-medium text-fg hover:border-accent hover:text-accent">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        Open plan
        <svg className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} viewBox="0 0 20 20" fill="currentColor">
          <path d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4z" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-panel py-1 shadow-xl">
          {error && <p className="px-3 py-2 text-sm text-danger">Could not load the plans. Is the backend running?</p>}
          {msg && <p className="px-3 py-2 text-sm text-danger">{msg}</p>}
          {!error && plans === null && <p className="px-3 py-2 text-sm text-fg-muted">Loading plans…</p>}
          {groups.map(([g, list]) => list.length > 0 && (
            <div key={g}>
              <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">{g}</div>
              {list.map((a) => (
                <div key={a.id} className={`group relative hover:bg-bg ${same(a) ? "bg-accent/10" : ""}`}>
                  <button type="button" onClick={() => { onOpen(asPct(a.weights)); setOpen(false); }}
                    className={`block w-full px-3 py-1.5 text-left ${a.type === "custom" ? "pr-10" : ""}`}>
                    <div className="flex items-center gap-2 text-sm text-fg">
                      <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                      {same(a) && <span className="shrink-0 text-xs text-accent">current</span>}
                    </div>
                    <div className="my-1 flex h-1.5 overflow-hidden rounded-full">
                      {Object.entries(a.weights).map(([k, w]) => (
                        <div key={k} style={{ width: `${w}%`, background: k === "CASH" ? "#9ca3af" : assets[k]?.color ?? "#888" }} />
                      ))}
                    </div>
                    <div className="truncate text-xs text-fg-muted">{weightsText(assets, a.weights)}</div>
                  </button>
                  {a.type === "custom" && (
                    <button type="button" onClick={() => remove(a)} aria-label={`Delete ${a.name}`} title="Delete this plan"
                      className="absolute right-2 top-1.5 flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:bg-danger/15 hover:text-danger">
                      <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                        <path d="M5 5l10 10M15 5L5 15" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
